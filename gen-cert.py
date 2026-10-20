#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为局域网访问生成自签名 HTTPS 证书（含手机离线所需）

为什么必须用 HTTPS：
    Service Worker 只在"安全上下文"里才能注册，局域网 http://192.168.x.x 不算，
    浏览器会直接拒绝。没有 Service Worker 就没有离线缓存 —— 手机上断网连页面都打不开。
    localhost 是例外（浏览器把它当安全上下文），所以电脑上用 http://localhost 一直没问题，
    这个问题只在手机上暴露。

做法：
    1. 生成一个本地 CA（ca.crt / ca.key）
    2. 用这个 CA 签发服务器证书（server.crt / server.key），SAN 里写入
       本机所有局域网 IP + localhost + 127.0.0.1
    3. 手机只需安装一次 ca.crt 并信任，之后 https://<局域网IP>:8443 就是可信的，
       Service Worker 正常注册，离线安装/离线使用全部可用。

用法：
    python gen-cert.py            # 生成（已存在则跳过，除非 --force）
    python gen-cert.py --force    # 重新生成（IP 变化后需要重签）
"""
import argparse
import datetime
import ipaddress
import os
import socket
import sys

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
except ImportError:
    sys.exit('缺少 cryptography 库：pip install cryptography')

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'cert')

CA_CRT = os.path.join(OUT, 'ca.crt')
CA_KEY = os.path.join(OUT, 'ca.key')
SRV_CRT = os.path.join(OUT, 'server.crt')
SRV_KEY = os.path.join(OUT, 'server.key')


def lan_ips():
    """收集本机所有局域网 IPv4 地址（证书里要写全，否则手机访问会报证书不匹配）"""
    ips = set(['127.0.0.1'])
    try:
        # 不需要真的连通，只是让内核选出默认出口网卡，从而拿到本机地址
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    # Windows 上再枚举一遍所有网卡地址
    if sys.platform == 'win32':
        try:
            import subprocess
            out = subprocess.run(['ipconfig'], capture_output=True, text=True,
                                 encoding='gbk', errors='replace').stdout
            import re
            for m in re.finditer(r'IPv4[^\d]*(\d+\.\d+\.\d+\.\d+)', out):
                ips.add(m.group(1))
        except Exception:
            pass
    # 去掉明显不是局域网的以及回环之外的公网地址不做限制（家用环境就是局域网）
    return sorted(ips)


def write(path, data, mode=None):
    with open(path, 'wb') as f:
        f.write(data)
    if mode is not None:
        try:
            os.chmod(path, mode)
        except OSError:
            pass


def gen_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='已存在也重新生成')
    ap.add_argument('--days', type=int, default=3650, help='有效期天数（默认 10 年）')
    args = ap.parse_args()

    if os.path.exists(SRV_CRT) and os.path.exists(CA_CRT) and not args.force:
        print('证书已存在，跳过生成：')
        print('  ' + CA_CRT)
        print('  ' + SRV_CRT)
        print('要重新生成（例如局域网 IP 变了）请加 --force')
        return

    os.makedirs(OUT, exist_ok=True)
    ips = lan_ips()
    print('将把以下地址写入证书：')
    for ip in ips:
        print('  ' + ip)
    print('  localhost / 127.0.0.1')

    now = datetime.datetime.now(datetime.timezone.utc)
    not_after = now + datetime.timedelta(days=args.days)

    # ---------- 1. 本地 CA ----------
    ca_key = gen_key()
    ca_name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, u'译词通本地开发者证书'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, u'TransWord Local CA'),
    ])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False, key_encipherment=False,
                data_encipherment=False, key_agreement=False, key_cert_sign=True,
                crl_sign=True, encipher_only=False, decipher_only=False,
            ), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    write(CA_CRT, ca_cert.public_bytes(serialization.Encoding.PEM))
    write(CA_KEY, ca_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()), 0o600)

    # ---------- 2. 服务器证书（由上面的 CA 签发） ----------
    srv_key = gen_key()
    san = [x509.DNSName(u'localhost')]
    for ip in ips:
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            pass
    srv_name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, u'译词通'),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, u'TransWord'),
    ])
    srv_cert = (
        x509.CertificateBuilder()
        .subject_name(srv_name)
        .issuer_name(ca_name)
        .public_key(srv_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(srv_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    write(SRV_CRT, srv_cert.public_bytes(serialization.Encoding.PEM))
    write(SRV_KEY, srv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()), 0o600)

    print('')
    print('证书已生成：')
    print('  CA（要装到手机上）: ' + CA_CRT)
    print('  服务器证书:         ' + SRV_CRT)
    print('')
    print('下一步：')
    print('  1) 运行  node server.js --https   （HTTPS 端口 8443）')
    print('  2) 手机浏览器打开 http://<局域网IP>:8765/ca.crt 下载 CA 证书并安装、信任')
    print('  3) 之后用 https://<局域网IP>:8443 打开，即可离线安装')


if __name__ == '__main__':
    main()
