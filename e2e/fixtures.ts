import { test as base, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/** Shared constants and fixtures for the end-to-end tests. */

export const ADMIN = { username: 'admin', password: 'E2e-Sup3r-Secret!' };

/** The fake printer started by playwright.config.ts (scripts/fake-printer.ts defaults). */
export const FAKE_PRINTER = {
  name: 'Fake P1S',
  model: 'P1S',
  ip: '127.0.0.1',
  serial: '01P00A000000001',
  accessCode: '12345678',
};

/** Every state-changing API call needs this header (CSRF protection). */
const CSRF = { 'x-requested-with': 'e2e' };

const controlUrl = (route: string) => `http://127.0.0.1:${process.env.E2E_CONTROL_PORT}${route}`;

/** Put the fake printer back on its initial running "Benchy" job with the sample storage. */
export async function resetFakePrinter(request: APIRequestContext) {
  const res = await request.post(controlUrl('/reset'));
  expect(res.ok()).toBe(true);
}

interface PrinterSummary {
  printer: { id: number; serial: string };
  connection: { status: string };
  gcodeState: string | null;
}

export async function listPrinters(request: APIRequestContext): Promise<PrinterSummary[]> {
  const res = await request.get('/api/printers');
  expect(res.ok()).toBe(true);
  return res.json();
}

export async function deleteAllPrinters(request: APIRequestContext) {
  for (const p of await listPrinters(request)) {
    const res = await request.delete(`/api/printers/${p.printer.id}`, { headers: CSRF });
    expect(res.ok()).toBe(true);
  }
}

/** Returns the id of the fake printer, adding it through the API if needed. */
export async function ensurePrinter(request: APIRequestContext): Promise<number> {
  const existing = (await listPrinters(request)).find((p) => p.printer.serial === FAKE_PRINTER.serial);
  if (existing) return existing.printer.id;
  const res = await request.post('/api/printers', {
    headers: CSRF,
    data: { ...FAKE_PRINTER, camera: 'none', tlsVerify: false },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).id;
}

/** Wait until the app sees the printer online and reporting the given print state. */
export async function waitForPrinterState(request: APIRequestContext, id: number, gcodeState: string) {
  await expect
    .poll(async () => {
      const p = (await listPrinters(request)).find((x) => x.printer.id === id);
      return p && `${p.connection.status}/${p.gcodeState}`;
    })
    .toBe(`online/${gcodeState}`);
}

/**
 * Click something that asks for confirmation and answer it in the app's
 * confirmation dialog (`role=alertdialog`, see ConfirmDialog.svelte).
 */
export async function clickAndAnswer(page: Page, trigger: Locator, accept: boolean) {
  await trigger.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  // The confirm button is the last one; Cancel comes first.
  const button = accept ? dialog.getByRole('button').last() : dialog.getByRole('button', { name: 'Cancel' });
  await button.click();
  await expect(dialog).toBeHidden();
}

export const clickAndConfirm = (page: Page, trigger: Locator) => clickAndAnswer(page, trigger, true);
export const clickAndDecline = (page: Page, trigger: Locator) => clickAndAnswer(page, trigger, false);

/** The card (section) titled by the given heading. */
export const card = (page: Page, heading: string | RegExp) =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: heading }) });

/**
 * `printerId`: the fake printer exists, is back on its running "Benchy" job
 * and the app sees it online.
 */
export const test = base.extend<{ printerId: number }>({
  printerId: async ({ page }, use) => {
    const request = page.request; // shares the logged-in session of the page
    await resetFakePrinter(request);
    const id = await ensurePrinter(request);
    await waitForPrinterState(request, id, 'RUNNING');
    await use(id);
  },
});

export { expect };
