# Test certificates

Used by `test_network_settings.py` (external-access Stage 4). They exist only
to make real TLS handshakes on loopback; nothing outside the test suite reads
them, and the keys protect nothing.

| File | What it is |
| --- | --- |
| `system-ca.pem` | *Semantic Studio Test System Root*: plays the operating system's store (SSL_CERT_FILE) |
| `company-ca.pem`, `company-ca.der` | *Semantic Studio Test Company Root*: plays the Zscaler root a user adds as a file; the DER copy tests the conversion |
| `system-site.pem`, `.key` | A server certificate for `system.test` and `www.w3.org`, signed by the system root |
| `company-site.pem`, `.key` | A server certificate for `secure.test` and `www.w3.org`, signed by the company root |

Valid for 100 years from 2026-10-30. The roots' keys were discarded after
signing. To make them again, with OpenSSL:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout company-ca.key -out company-ca.pem -days 36500 \
  -subj "/CN=Semantic Studio Test Company Root" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout company-site.key -out company-site.csr -subj "/CN=secure.test"
printf "subjectAltName=DNS:secure.test,DNS:www.w3.org\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in company-site.csr -CA company-ca.pem -CAkey company-ca.key -CAcreateserial \
  -out company-site.pem -days 36500 -extfile ext.cnf
openssl x509 -in company-ca.pem -outform DER -out company-ca.der
```

The system pair is made the same way, with `system` for `company` and
`system.test` for `secure.test`.
