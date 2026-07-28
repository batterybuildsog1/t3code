import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(
  endpointUrl: string,
  credential: string,
  publicBasePath: string = import.meta.env.BASE_URL,
): string {
  const url = new URL(endpointUrl);
  const base = `/${publicBasePath}`.replace(/\/+/gu, "/").replace(/\/$/u, "");
  url.pathname = `${base}/pair`;
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}
