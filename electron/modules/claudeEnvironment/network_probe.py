"""Network facts only: explicit HTTP proxy and the dedicated local DNS socket.

No account requests, system DNS fallback, proxy lifecycle operations or file writes.
"""
import argparse
import concurrent.futures
import ctypes
import ipaddress
import json
import os
import secrets
import socket
import struct
import urllib.request


def request(url):
    proxy = os.environ['HTTPS_PROXY']
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
    message = urllib.request.Request(url, headers={'User-Agent': 'CodePal-Claude-Environment/1.0', 'Accept': 'application/json, text/plain'})
    with opener.open(message, timeout=6) as response:
        data = response.read(65537)
        if len(data) > 65536:
            raise ValueError('response too large')
        return data.decode('utf-8')


def skip_name(packet, offset):
    for _ in range(128):
        size = packet[offset]
        if size & 0xC0 == 0xC0:
            if offset + 1 >= len(packet):
                raise ValueError('truncated pointer')
            return offset + 2
        offset += 1
        if size == 0:
            return offset
        if size > 63 or offset + size > len(packet):
            raise ValueError('invalid DNS name')
        offset += size
    raise ValueError('invalid DNS name')


def txt_records(packet, identifier):
    if len(packet) < 12:
        raise ValueError('short DNS packet')
    tx, flags, qd, answers, _, _ = struct.unpack('!6H', packet[:12])
    if tx != identifier or not flags & 0x8000 or flags & 0xF or flags & 0x200 or qd > 4 or answers > 64:
        raise ValueError('unusable DNS answer')
    offset = 12
    for _ in range(qd):
        offset = skip_name(packet, offset) + 4
    result = []
    for _ in range(answers):
        offset = skip_name(packet, offset)
        kind, record_class, _, length = struct.unpack('!HHIH', packet[offset:offset + 10])
        offset += 10
        end = offset + length
        if end > len(packet):
            raise ValueError('truncated DNS record')
        if kind == 16 and record_class == 1:
            parts = []
            while offset < end:
                size = packet[offset]
                offset += 1
                if offset + size > end:
                    raise ValueError('truncated TXT segment')
                parts.append(packet[offset:offset + size].decode('ascii'))
                offset += size
            result.append(parts)
        offset = end
    return result


def query_resolver(domain, port):
    identifier = secrets.randbelow(65536)
    name = b''.join(bytes([len(label)]) + label.encode('ascii') for label in domain.split('.')) + b'\0'
    message = struct.pack('!6H', identifier, 0x100, 1, 0, 0, 0) + name + struct.pack('!HH', 16, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.settimeout(4)
        connection.connect(('127.0.0.1', port))
        connection.send(message)
        packet = connection.recv(8192)
    # Akamai's ns field identifies the recursive resolver; ip / ecs are different facts.
    values = []
    for record in txt_records(packet, identifier):
        if len(record) >= 2 and record[0] == 'ns':
            value = str(ipaddress.ip_address(record[1]))
            if ipaddress.ip_address(value).is_global:
                values.append(value)
    return values


def egress():
    for host in ['api.anthropic.com', 'www.cloudflare.com']:
        try:
            trace = dict(line.split('=', 1) for line in request('https://' + host + '/cdn-cgi/trace').splitlines() if '=' in line)
            value = str(ipaddress.ip_address(trace.get('ip', '')))
            country = trace.get('loc', '')
            if len(country) == 2 and country.isalpha() and country.isupper():
                return {'ok': True, 'ip': value, 'country': country}
        except Exception:
            continue
    return {'ok': False}


def dns(port):
    results = []
    complete = True
    for domain in ['whoami.ds.akahelp.net', 'whoami.ipv4.akahelp.net']:
        try:
            addresses = query_resolver(domain, port)
            if not addresses:
                complete = False
            results.extend(addresses)
        except Exception:
            complete = False
    resolvers = []
    for value in dict.fromkeys(results):
        country = None
        try:
            data = json.loads(request('https://ipwho.is/' + value + '?fields=ip,success,country_code'))
            if data.get('success') is True and data.get('ip') == value:
                code = data.get('country_code', '')
                if len(code) == 2 and code.isalpha() and code.isupper():
                    country = code
        except Exception:
            pass
        if country is None:
            complete = False
        resolvers.append({'ip': value, 'country': country})
    return {'resolvers': resolvers, 'complete': complete and bool(resolvers)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dns-port', type=int, required=True)
    args = parser.parse_args()
    if not 0 < args.dns_port < 65536:
        raise ValueError('invalid port')
    library = ctypes.CDLL('/usr/lib/system/libsystem_sandbox.dylib')
    library.sandbox_check.restype = ctypes.c_int
    active = library.sandbox_check(os.getpid(), None, 0) == 1
    if not active:
        print(json.dumps({'isolationActive': False, 'egress': {}, 'dns': {}}))
        return
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        http_task = executor.submit(egress)
        dns_task = executor.submit(dns, args.dns_port)
        print(json.dumps({'isolationActive': True, 'egress': http_task.result(), 'dns': dns_task.result()}))


if __name__ == '__main__':
    main()
