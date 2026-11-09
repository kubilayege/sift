import { capsule, endpoint, redirect, text } from "lakebed/server";
import { RELEASES, VERSION } from "../shared/releases";
import { installScript } from "./install";

const origin = (req: { headers: { get(name: string): string | null } }) => {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "sift.lakebed.app";
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = req.headers.get("x-forwarded-proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
};

// Stable download URLs (/download/sift-macos-arm64.tar.gz) that point at the current GitHub release.
const downloads = Object.fromEntries(
  RELEASES.map((r) => [
    r.name,
    endpoint({ method: "GET", path: `/download/${r.name}.tar.gz` }, () => redirect(r.url))
  ])
);

export default capsule({
  name: "sift · review what your agents changed",
  auth: { requireSignIn: false },
  schema: {},
  endpoints: {
    install: endpoint({ method: "GET", path: "/install.sh" }, (_ctx, req) =>
      text(installScript(origin(req)), {
        headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache" }
      })
    ),
    sums: endpoint({ method: "GET", path: "/download/SHA256SUMS" }, () =>
      text(RELEASES.map((r) => `${r.sha256}  ${r.name}.tar.gz`).join("\n") + "\n")
    ),
    version: endpoint({ method: "GET", path: "/version" }, () => text(VERSION + "\n")),
    ...downloads
  }
});
