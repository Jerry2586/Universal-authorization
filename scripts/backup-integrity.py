#!/usr/bin/env python3
"""Versioned encrypt-then-MAC envelope around an OpenSSL salted backup.

This authenticates bytes against the separately held backup secret; it does not
attest that the source host or the archived business data was malware-free.
"""
import argparse
import base64
import hashlib
import hmac
import os
import re
import stat
import subprocess
import tempfile
import sys

MAGIC = b"APPGOG-BACKUP\x00\x01"
SALT_BYTES = 16
TAG_BYTES = 32
ITERATIONS = 200000
CHUNK_BYTES = 1024 * 1024
DOMAIN = b"\x00APPGOG-BACKUP-AUTH-V1"


def regular_input(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("输入必须是独立普通文件，拒绝链接或设备")
        return os.fdopen(fd, "rb"), info
    except BaseException:
        os.close(fd)
        raise


def unchanged(stream, before):
    after = os.fstat(stream.fileno())
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(after, field) != getattr(before, field) for field in fields):
        raise ValueError("读取期间文件发生变化，拒绝备份")


def key_parent(path):
    # Release aliases are supported, but the final directory and every ancestor
    # must be owned by this administrator or root and not writable by others.
    if os.name != "posix":
        return None, os.path.realpath(path)
    # Check the alias path as well as its canonical destination. A trusted
    # destination must not hide an alias controlled by an untrusted directory.
    absolute = path if os.path.isabs(path) else os.path.join(os.getcwd(), path)
    if ".." in absolute.split("/"):
        raise ValueError("恢复密钥路径不能包含父目录跳转")
    prefix = "/"
    for component in filter(None, absolute.split("/")):
        prefix = os.path.join(prefix, component)
        try:
            entry = os.lstat(prefix)
        except FileNotFoundError:
            if prefix != absolute:
                raise
            break  # key-init may create only the final missing file.
        if entry.st_uid not in (0, os.geteuid()):
            raise ValueError("恢复密钥路径存在不可信属主")
        if stat.S_ISDIR(entry.st_mode):
            sticky_root = entry.st_uid == 0 and bool(entry.st_mode & stat.S_ISVTX)
            if entry.st_mode & 0o022 and not sticky_root:
                raise ValueError("恢复密钥别名目录可被其它用户写入")
        elif stat.S_ISLNK(entry.st_mode) and prefix != absolute:
            target = os.stat(prefix)
            if target.st_uid not in (0, os.geteuid()) or target.st_mode & 0o022:
                raise ValueError("恢复密钥别名目录目标不安全")
    resolved = os.path.realpath(absolute)
    parent = os.path.dirname(resolved)
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in ["", *parent.strip("/").split("/")]:
            if component:
                next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = next_fd
            info = os.fstat(directory)
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX) and parent != "/"
            if info.st_uid not in (0, os.geteuid()) or (info.st_mode & 0o022 and not sticky_root):
                raise ValueError("恢复密钥目录属主或写权限不安全")
        # A public sticky directory is valid only as an ancestor, never as key parent.
        if os.fstat(directory).st_mode & 0o022:
            raise ValueError("恢复密钥最终目录不能由其它用户写入")
        return directory, os.path.basename(resolved)
    except BaseException:
        os.close(directory)
        raise


def key_input(path):
    directory, name = key_parent(path)
    if directory is None:
        return regular_input(name)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in (0, os.geteuid()):
            raise ValueError("恢复密钥必须为可信属主的独立普通文件")
        return os.fdopen(fd, "rb"), info
    except BaseException:
        os.close(fd)
        raise


def initialize_key(path):
    directory, name = key_parent(path)
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600,
                     **({"dir_fd": directory} if directory is not None else {}))
        with os.fdopen(fd, "wb") as stream:
            stream.write(base64.b64encode(os.urandom(48)) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        if directory is not None:
            os.fsync(directory)
    except FileExistsError:
        secret(path)  # Validate an existing key; never overwrite or chmod it.
    finally:
        if directory is not None:
            os.close(directory)


def secret(path):
    with_file, info = key_input(path)
    with with_file as stream:
        if info.st_size > 258:
            raise ValueError("恢复密钥文件超限")
        if os.name == "posix" and info.st_mode & 0o077:
            raise ValueError("恢复密钥权限过宽，必须为600或更严格")
        value = stream.read(258)
        unchanged(stream, info)
    if value.endswith(b"\r\n"):
        value = value[:-2]
    elif value.endswith(b"\n"):
        value = value[:-1]
    if not re.fullmatch(rb"[A-Za-z0-9+/=_-]{32,256}", value):
        raise ValueError("恢复密钥格式无效")
    return value


def authenticator(key, salt):
    derived = hashlib.pbkdf2_hmac("sha256", key + DOMAIN, salt, ITERATIONS, dklen=32)
    return hmac.new(derived, MAGIC + salt, hashlib.sha256)


def copy_bytes(source, target, count, mac=None):
    while count:
        block = source.read(min(CHUNK_BYTES, count))
        if not block:
            raise ValueError("备份被截断")
        if target:
            target.write(block)
        if mac:
            mac.update(block)
        count -= len(block)


def openssl_cipher(key, source, target, decrypt=False):
    # A single normalized key snapshot is shared by encryption and authentication.
    with tempfile.TemporaryFile() as passphrase:
        passphrase.write(key + b"\n")
        passphrase.flush()
        passphrase.seek(0)
        subprocess.run(
            ["openssl", "enc", "-d" if decrypt else "-e", "-aes-256-cbc", "-salt",
             "-pbkdf2", "-iter", str(ITERATIONS), "-pass", "fd:" + str(passphrase.fileno())],
            stdin=source, stdout=target, pass_fds=(passphrase.fileno(),), check=True)


def envelope(action, key_path, input_path, output_path=None, allow_legacy=False, producer=None, consumer=None):
    key = None if action == "snapshot" else secret(key_path)
    source, info = (tempfile.TemporaryFile(), None) if producer else regular_input(input_path)
    output = None
    spool = None
    created = False
    try:
        with source:
            if producer:
                subprocess.run(producer, stdin=subprocess.DEVNULL, stdout=source, check=True)
                source.seek(0)
                info = os.fstat(source.fileno())
            reader = source
            if action == "encrypt":
                spool = tempfile.TemporaryFile()
                openssl_cipher(key, source, spool)
                unchanged(source, info)
                spool.seek(0)
                reader = spool
            prefix = reader.read(len(MAGIC))
            legacy = prefix.startswith(b"Salted__")
            if action == "snapshot":
                if not allow_legacy:
                    raise ValueError("旧明文备份须显式开启兼容恢复")
                source.seek(0)
                count = info.st_size
                mac = None
            elif action in ("seal", "encrypt"):
                cipher_size = os.fstat(reader.fileno()).st_size
                if not legacy or cipher_size < 32:
                    raise ValueError("加密内容不是完整 OpenSSL salted 备份")
                salt = os.urandom(SALT_BYTES)
                mac = authenticator(key, salt)
                reader.seek(0)
                count = cipher_size
            elif prefix == MAGIC:
                salt = source.read(SALT_BYTES)
                count = info.st_size - len(MAGIC) - SALT_BYTES - TAG_BYTES
                if len(salt) != SALT_BYTES or count < 32:
                    raise ValueError("认证备份头或内容不完整")
                mac = authenticator(key, salt)
            elif action in ("open", "decrypt") and allow_legacy and legacy and info.st_size >= 32:
                print("警告：显式恢复未认证旧备份；不能证明其未被篡改。", file=sys.stderr)
                source.seek(0)
                count = info.st_size
                mac = None
            else:
                raise ValueError("备份缺少有效认证；旧格式仅可显式开启兼容恢复")
            if action == "decrypt":
                # Anonymous ciphertext snapshot: authenticate before OpenSSL receives it.
                spool = tempfile.TemporaryFile()
            elif consumer:
                output = tempfile.TemporaryFile()
            elif action != "verify":
                fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                created = True
                try:
                    output = os.fdopen(fd, "wb")
                except BaseException:
                    os.close(fd)
                    raise
                if action in ("seal", "encrypt"):
                    output.write(MAGIC + salt)
            copy_bytes(reader, spool if action == "decrypt" else output, count, mac)
            if action in ("seal", "encrypt"):
                output.write(mac.digest())
            elif mac is not None:
                if not hmac.compare_digest(source.read(TAG_BYTES), mac.digest()):
                    raise ValueError("备份认证失败：密钥不匹配或文件已被篡改")
            if reader.read(1):
                raise ValueError("备份存在尾随数据")
            unchanged(source, info)
            if action == "decrypt":
                spool.seek(0)
                if consumer:
                    output = tempfile.TemporaryFile()
                else:
                    fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                    created = True
                    try:
                        output = os.fdopen(fd, "wb")
                    except BaseException:
                        os.close(fd)
                        raise
                openssl_cipher(key, spool, output, decrypt=True)
            if output:
                output.flush()
                os.fsync(output.fileno())
                if consumer:
                    output.seek(0)
                    subprocess.run(consumer, stdin=output, check=True)
                output.close()
                output = None
    except BaseException:
        try:
            if output:
                output.close()
        finally:
            if created:
                os.unlink(output_path)
        raise
    finally:
        if spool is not None:
            spool.close()


def main():
    parser = argparse.ArgumentParser(description="APPGOG 完整备份认证")
    parser.add_argument("action", choices=("key-init", "snapshot", "encrypt", "seal", "open", "verify", "decrypt"))
    parser.add_argument("--key")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--allow-legacy", action="store_true")
    transfer = parser.add_mutually_exclusive_group()
    transfer.add_argument("--producer", nargs=argparse.REMAINDER)
    transfer.add_argument("--consumer", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "key-init":
        if not args.key or any((args.input, args.output, args.producer, args.consumer, args.allow_legacy)):
            parser.error("key-init仅接受密钥路径")
    else:
        if args.action != "snapshot" and not args.key:
            parser.error("缺少密钥")
        if bool(args.input) == bool(args.producer) or (args.producer and args.action != "encrypt"):
            parser.error("提供输入路径，或仅encrypt提供producer")
        if args.consumer and (args.action not in ("decrypt", "snapshot") or args.output):
            parser.error("consumer仅用于decrypt/snapshot，不能同时指定输出")
        if (args.action == "verify" and (args.output or args.allow_legacy)) or (args.action != "verify" and not (args.output or args.consumer)):
            parser.error("verify不接受输出或旧格式；其它动作必须指定输出或consumer")
    try:
        if args.action == "key-init":
            initialize_key(args.key)
        else:
            envelope(args.action, args.key, args.input, args.output, args.allow_legacy, args.producer, args.consumer)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("备份认证失败：" + str(error), file=sys.stderr)
        return 1
    if args.action == "verify":
        print("备份认证通过；尚未证明归档内容或业务可恢复。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
