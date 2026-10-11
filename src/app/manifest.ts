import type { MetadataRoute } from "next";
import { BRAND_DESCRIPTION, INSTALL_NAME } from "@/lib/brand";

/**
 * Served at /manifest.webmanifest (public in src/proxy.ts). Share target posts into the inbox.
 * Static and English: an installed app keeps the one name it was installed with (lib/brand.ts).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: INSTALL_NAME,
    short_name: INSTALL_NAME,
    description: BRAND_DESCRIPTION.en,
    lang: "en",
    id: "/",
    start_url: "/icons/offline-capture.html",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#efe8dc",
    theme_color: "#c45c26",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // The mark sits inside the 80% safe zone of a full-bleed tile, so the same files serve maskable.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: "/api/capture/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
