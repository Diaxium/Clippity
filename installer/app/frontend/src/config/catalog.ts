/**
 * The concrete Clippity install manifest for the frontend — the mirror of
 * the Rust `installer_services::manifest`. Kept here so the wizard renders
 * real component names, sizes, and product facts in browser preview
 * (where the backend commands aren't reachable). Under the real Tauri
 * shell these same shapes come back from `get_components` etc.
 */

import type {
  Component,
  DataCategory,
  ProductInfo,
  UpdateInfo,
} from "@clippity/installer-shared";

const MB = 1_000_000;
const GB = 1_000_000_000;

export const PRODUCT: ProductInfo = {
  name: "Clippity",
  version: "0.3.1",
  arch: "64-bit",
  publisher: "Clippity",
  defaultInstallDir: "C:\\Program Files\\Clippity",
};

/** Outbound links the Complete / Welcome screens open in the browser. */
export const LINKS = {
  help: "https://github.com/Diaxium/Clippity#readme",
  docs: "https://github.com/Diaxium/Clippity/tree/main/docs",
  whatsNew: "https://github.com/Diaxium/Clippity/releases",
  releaseNotes: "https://github.com/Diaxium/Clippity/releases",
} as const;

/** The version considered "already installed" in the maintenance flows. */
export const INSTALLED_VERSION = "0.2.0";
export const INSTALL_LOCATION = "C:\\Program Files\\Clippity";

export const COMPONENTS: Component[] = [
  {
    id: "core",
    name: "Main application",
    description: "Core Clippity application files",
    sizeBytes: 162 * MB,
    required: true,
    recommendedDefault: true,
  },
  {
    id: "capture",
    name: "Capture integration",
    description: "Enable global capture and shortcuts",
    sizeBytes: 48 * MB,
    required: false,
    recommendedDefault: true,
  },
  {
    id: "gif",
    name: "GIF encoder (FFmpeg)",
    description: "Create high-quality GIFs",
    sizeBytes: 28 * MB,
    required: false,
    recommendedDefault: false,
  },
  {
    id: "ocr",
    name: "OCR engine",
    description: "Extract text from screenshots",
    sizeBytes: 36 * MB,
    required: false,
    recommendedDefault: false,
  },
];

export const DATA_CATEGORIES: DataCategory[] = [
  {
    id: "app",
    name: "Application files",
    sizeBytes: 184 * MB,
    destructive: false,
  },
  {
    id: "shortcuts",
    name: "Shortcuts and system integrations",
    sizeBytes: 4 * MB,
    destructive: false,
  },
  {
    id: "cache",
    name: "Cached files",
    sizeBytes: 326 * MB,
    destructive: false,
  },
  {
    id: "settings",
    name: "Settings and presets",
    sizeBytes: 8 * MB,
    destructive: true,
  },
  {
    id: "content",
    name: "Local captures and projects",
    sizeBytes: 14 * GB + 500 * MB,
    destructive: true,
  },
];

/** The update the maintenance flow surfaces (installed 1.4.0 → 1.5.0). */
export const UPDATE_INFO: UpdateInfo = {
  installed: { version: INSTALLED_VERSION, channel: "stable" },
  latest: { version: "0.3.1", channel: "stable" },
  available: true,
  downloadBytes: 82_400_000,
  signature: "verified",
  releaseNotes: [
    "Improved recording quality with adaptive bitrate.",
    "Faster cloud sync and upload performance.",
    "OCR engine accuracy and performance improvements.",
    "UI polish, accessibility, and stability enhancements.",
  ],
  releasePage: LINKS.releaseNotes,
  publishedAt: "",
};
