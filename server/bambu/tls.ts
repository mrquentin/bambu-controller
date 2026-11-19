import fs from 'node:fs';
import path from 'node:path';
import type tls from 'node:tls';

/**
 * Printer TLS trust.
 *
 * Every printer service (MQTT 8883, FTPS 990, camera 6000, RTSPS 322) presents
 * a certificate with CN = <serial>, issued by "BBL CA" (Bambu Lab's private
 * root, extracted from the LanBu app; valid until 2032). Verifying the chain
 * against that CA *and* the CN against the configured serial stops another
 * device on the LAN from impersonating the printer to harvest the access code.
 *
 * Models signed by a different CA can opt out per printer (tls_verify = 0), or
 * extra CAs can be added with PRINTER_EXTRA_CA_FILE.
 */
export const BBL_CA_FILE = path.resolve(import.meta.dirname, 'bbl-ca.pem');

const cas = [fs.readFileSync(BBL_CA_FILE, 'utf8')];
if (process.env.PRINTER_EXTRA_CA_FILE) cas.push(fs.readFileSync(process.env.PRINTER_EXTRA_CA_FILE, 'utf8'));

export interface TlsTarget {
  serial: string;
  tls_verify: number;
}

/** Subset of TLS options accepted by tls.connect, mqtt.js and basic-ftp alike. */
export interface PrinterTlsOptions {
  ca?: string[];
  rejectUnauthorized: boolean;
  checkServerIdentity?: (host: string, cert: tls.PeerCertificate) => Error | undefined;
}

export function printerTlsOptions(target: TlsTarget): PrinterTlsOptions {
  if (!target.tls_verify) return { rejectUnauthorized: false };
  const expected = target.serial.toUpperCase();
  return {
    ca: cas,
    rejectUnauthorized: true,
    // Connections are made by IP, so the hostname check is replaced by a check
    // that the certificate belongs to this specific printer.
    checkServerIdentity: (_host, cert) => {
      const cn = String(cert.subject?.CN ?? '').toUpperCase();
      return cn === expected
        ? undefined
        : Object.assign(new Error(`Printer certificate is for "${cn}", expected serial "${expected}"`), {
            code: 'ERR_PRINTER_CERT_MISMATCH',
          });
    },
  };
}

/** Human-friendly explanation for TLS verification failures. */
export function describeTlsError(err: unknown): string | null {
  const e = err as NodeJS.ErrnoException & { code?: string };
  const msg = e?.message ?? String(err);
  if (e?.code === 'ERR_PRINTER_CERT_MISMATCH' || /expected serial/.test(msg)) {
    return `${msg}. Check the serial number.`;
  }
  if (
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_SIGNATURE_FAILURE|unable to verify|self[- ]signed|certificate/i.test(
      `${e?.code ?? ''} ${msg}`,
    )
  ) {
    return (
      'The printer certificate could not be verified against the Bambu Lab CA. ' +
      'If this is a newer model, disable "Verify printer certificate" in the printer settings.'
    );
  }
  return null;
}
