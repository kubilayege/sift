export type Release = {
  /** sift-<os>-<arch> */
  name: string;
  /** Where the tarball lives (a GitHub release asset). */
  url: string;
  sha256: string;
  size: number;
};

/** Source and release binaries. Binaries are GitHub release assets; Lakebed storage does not take executables. */
export const REPO = "kubilayege/sift";

export const PLATFORMS: Record<string, { label: string; detail: string }> = {
  "sift-macos-arm64": { label: "macOS", detail: "Apple Silicon" },
  "sift-macos-x86_64": { label: "macOS", detail: "Intel" },
  "sift-linux-x86_64": { label: "Linux", detail: "x86_64 · static" },
  "sift-linux-arm64": { label: "Linux", detail: "arm64 · static" }
};
