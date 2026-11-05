import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import QRCode from "qrcode";

export const newToken = () => crypto.randomBytes(32).toString("base64url"); // 43 chars

export function lanAddresses(): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

const TAILSCALE_BINS = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
];

export interface TailscaleInfo {
  dnsName: string | null;
  hostName: string | null;
  ips: string[];
}

/** Reads `tailscale status --json` if the CLI exists. Never required. */
export async function detectTailscale(): Promise<TailscaleInfo | null> {
  for (const bin of TAILSCALE_BINS) {
    if (bin.includes("/") || bin.includes("\\")) {
      if (!fs.existsSync(bin)) continue;
    }
    const out = await new Promise<string | null>((resolve) =>
      execFile(bin, ["status", "--json"], { timeout: 3000, windowsHide: true }, (err, stdout) =>
        resolve(err ? null : stdout),
      ),
    );
    if (!out) continue;
    try {
      const self = JSON.parse(out).Self ?? {};
      return {
        dnsName: typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : null,
        hostName: self.HostName ?? null,
        ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip: string) => ip.includes(".")) : [],
      };
    } catch {
      return null;
    }
  }
  return null;
}

export interface RemoteUrl {
  label: string;
  url: string;
}

export async function remoteUrls(
  port: number,
  host: string,
): Promise<{ urls: RemoteUrl[]; tailscale: TailscaleInfo | null }> {
  const urls: RemoteUrl[] = [{ label: "This computer", url: `http://localhost:${port}` }];
  const all = host === "0.0.0.0";
  for (const a of lanAddresses())
    if (all || a.address === host) urls.push({ label: `LAN (${a.name})`, url: `http://${a.address}:${port}` });
  const tailscale = await detectTailscale();
  if (tailscale) {
    if (tailscale.dnsName) urls.push({ label: "Tailscale", url: `http://${tailscale.dnsName.split(".")[0]}:${port}` });
    for (const ip of tailscale.ips)
      if (all || ip === host) urls.push({ label: "Tailscale IP", url: `http://${ip}:${port}` });
  }
  return { urls, tailscale };
}

/** QR code (SVG data URL) of the URL with the token in the fragment, so it never reaches server logs. */
export const qrFor = (url: string, token: string) =>
  QRCode.toDataURL(`${url}/#token=${token}`, { margin: 1, width: 240, color: { dark: "#080b10", light: "#ffffff" } });
