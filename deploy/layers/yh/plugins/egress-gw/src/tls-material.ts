import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TlsMaterial {
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
}

export function generateTlsMaterial(dir: string, hosts: string[]): TlsMaterial {
  mkdirSync(dir, { recursive: true });
  const caCertPath = join(dir, "ca.crt");
  const caKeyPath = join(dir, "ca.key");
  const serverCertPath = join(dir, "server.crt");
  const serverKeyPath = join(dir, "server.key");

  if (
    existsSync(caCertPath) &&
    existsSync(caKeyPath) &&
    existsSync(serverCertPath) &&
    existsSync(serverKeyPath)
  ) {
    return {
      caCert: readFileSync(caCertPath, "utf8"),
      caKey: readFileSync(caKeyPath, "utf8"),
      serverCert: readFileSync(serverCertPath, "utf8"),
      serverKey: readFileSync(serverKeyPath, "utf8"),
    };
  }

  const openssl = (args: string[]): void => {
    execFileSync("openssl", args, { stdio: "pipe" });
  };
  const san = hosts.map((h) => `DNS:${h}`).join(",");
  const extPath = join(dir, "server.ext");
  writeFileSync(extPath, `subjectAltName=${san}\n`);

  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKeyPath, "-out", caCertPath, "-days", "3650", "-subj", "/CN=qm-egress-ca"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKeyPath, "-out", join(dir, "server.csr"), "-subj", "/CN=api.deepseek.com"]);
  openssl([
    "x509", "-req", "-in", join(dir, "server.csr"), "-CA", caCertPath, "-CAkey", caKeyPath,
    "-CAcreateserial", "-out", serverCertPath, "-days", "365", "-extfile", extPath,
  ]);
  return {
    caCert: readFileSync(caCertPath, "utf8"),
    caKey: readFileSync(caKeyPath, "utf8"),
    serverCert: readFileSync(serverCertPath, "utf8"),
    serverKey: readFileSync(serverKeyPath, "utf8"),
  };
}
