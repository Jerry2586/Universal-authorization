#!/usr/bin/env python3
"""Versioned encrypt-then-MAC envelope around an OpenSSL salted backup.

This authenticates bytes against the separately held backup secret; it does not
attest that the source host or the archived business data was malware-free.
"""
import argparse
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


def secret(path):
    # The signed release layout intentionally links .backup-key to shared/.backup-key.
    # Resolve that alias once, then open the final file without following a new link.
    with_file, info = regular_input(os.path.realpath(path))
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


def envelope(action, key_path, input_path, output_path=None, allow_legacy=False):
    key = secret(key_path)
    source, info = regular_input(input_path)
    output = None
    spool = None
    created = False
    try:
        with source:
            reader = source
            if action == "encrypt":
                spool = tempfile.TemporaryFile()
                openssl_cipher(key, source, spool)
                unchanged(source, info)
                spool.seek(0)
                reader = spool
            prefix = reader.read(len(MAGIC))
            legacy = prefix.startswith(b"Salted__")
            if action in ("seal", "encrypt"):
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
    parser.add_argument("action", choices=("encrypt", "seal", "open", "verify", "decrypt"))
    parser.add_argument("--key", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output")
    parser.add_argument("--allow-legacy", action="store_true")
    args = parser.parse_args()
    if (args.action == "verify" and (args.output or args.allow_legacy)) or (args.action != "verify" and not args.output):
        parser.error("verify不接受输出或旧格式；encrypt/seal/open/decrypt必须提供输出")
    try:
        envelope(args.action, args.key, args.input, args.output, args.allow_legacy)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print("备份认证失败：" + str(error), file=sys.stderr)
        return 1
    if args.action == "verify":
        print("备份认证通过；尚未证明归档内容或业务可恢复。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
