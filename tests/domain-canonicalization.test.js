import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeDomain } from '../packages/core/src/canonicalize.js';

test('授权域名统一协议、端口、大小写、尾点与 www 别名', () => {
  assert.equal(canonicalizeDomain(' HTTPS://WWW.Example.COM.:443/path?q=1#hash '), 'example.com');
  assert.equal(canonicalizeDomain('www.example.com:8443/path'), 'example.com');
  assert.equal(canonicalizeDomain('example.com.'), 'example.com');
});

test('Unicode 域名与 Punycode 域名归一为同一个稳定值', () => {
  assert.equal(canonicalizeDomain('例子.测试'), 'xn--fsqu00a.xn--0zwm56d');
  assert.equal(canonicalizeDomain('XN--FSQU00A.XN--0ZWM56D'), 'xn--fsqu00a.xn--0zwm56d');
});

test('IPv4 与 IPv6 地址在带端口时仍保持正确主机身份', () => {
  assert.equal(canonicalizeDomain('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(canonicalizeDomain('http://[2001:db8::1]:8080/path'), '2001:db8::1');
  assert.equal(canonicalizeDomain('[2001:db8::1]:8443'), '2001:db8::1');
});

test('授权域名拒绝凭据、非 HTTP 协议、非法端口和非法 DNS 标签', () => {
  for (const value of [
    'https://user:pass@example.com',
    'ftp://example.com',
    'example.com:not-a-port',
    'bad_host.example.com',
    '-bad.example.com',
    'bad-.example.com',
  ]) {
    assert.throws(() => canonicalizeDomain(value), (error) => error.code === 'DOMAIN_INVALID');
  }
});
