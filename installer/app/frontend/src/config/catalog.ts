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
  version: "1.5.0",
  arch: "64-bit",
  publisher: "Clippity",
  defaultInstallDir: "C:\\Program Files\\Clippity",
};

/** Outbound links the Complete / Welcome screens open in the browser. */
export const LINKS = {
  help: "https://clippity.app/help",
  docs: "https://clippity.app/docs",
  whatsNew: "https://clippity.app/whats-new",
  releaseNotes: "https://clippity.app/releases",
} as const;

/** The version considered "already installed" in the maintenance flows. */
export const INSTALLED_VERSION = "1.4.0";
export const INSTALL_LOCATION = "C:\\Program Files\\Clippity";
export const LAST_UPDATED = "May 9, 2025, 10:47 AM";

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
    id: "assoc",
    name: "File associations",
    description: "Open supported files with Clippity",
    sizeBytes: 12 * MB,
    required: false,
    recommendedDefault: true,
  },
  {
    id: "startup",
    name: "Startup helper",
    description: "Faster launch and background tasks",
    sizeBytes: 6 * MB,
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
  {
    id: "cloud",
    name: "Cloud sync (Beta)",
    description: "Sync captures across devices",
    sizeBytes: 22 * MB,
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
    id: "credentials",
    name: "Saved account credentials",
    sizeBytes: 2 * MB,
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
  latest: { version: "1.5.0", channel: "stable" },
  available: true,
  downloadBytes: 82_400_000,
  signature: "verified",
  releaseNotes: [
    "Improved recording quality with adaptive bitrate.",
    "Faster cloud sync and upload performance.",
    "OCR engine accuracy and performance improvements.",
    "UI polish, accessibility, and stability enhancements.",
  ],
};
