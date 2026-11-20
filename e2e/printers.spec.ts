import { FAKE_PRINTER, deleteAllPrinters, expect, resetFakePrinter, test } from './fixtures.ts';

test('add a printer manually: it shows up online with progress and temperatures', async ({ page }) => {
  await deleteAllPrinters(page.request);
  await resetFakePrinter(page.request);

  await page.goto('/');
  await expect(page.getByText('No printers yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Add printer' }).click();
  await expect(page.getByRole('heading', { name: 'Add printer', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /Add manually/ }).click();
  await page.getByLabel('Name').fill(FAKE_PRINTER.name);
  await page.getByLabel(/^Model/).selectOption(FAKE_PRINTER.model);
  await page.getByLabel('IP address').fill(FAKE_PRINTER.ip);
  await page.getByLabel('Serial number').fill(FAKE_PRINTER.serial);
  await page.getByLabel('Access code').fill(FAKE_PRINTER.accessCode);
  // The fake printer's certificate is self-signed, not issued by the Bambu CA.
  await page.getByLabel(/Verify printer certificate/).uncheck();
  await page.getByRole('button', { name: 'Add printer' }).click();

  // The app checks the connection, saves and opens the printer page.
  await expect(page).toHaveURL(/#\/printer\/\d+$/);
  await expect(page.getByRole('heading', { name: FAKE_PRINTER.name, level: 1 })).toBeVisible();

  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Printers' }).click();
  const tile = page.getByRole('link', { name: new RegExp(FAKE_PRINTER.name) });
  await expect(tile).toBeVisible();
  await expect(tile.getByText('Online')).toBeVisible();
  await expect(tile.getByText('Printing')).toBeVisible();
  await expect(tile.getByText('Benchy')).toBeVisible();
  await expect(tile.getByText('12%')).toBeVisible();
  await expect(tile.getByText('Layer 18 / 150')).toBeVisible();
  await expect(tile.getByText(/Nozzle \d+° \/ 220°/)).toBeVisible();
  await expect(tile.getByText(/Bed \d+° \/ 55°/)).toBeVisible();
});

test('adding a printer with a wrong access code is refused', async ({ page }) => {
  await page.goto('/#/add');
  await page.getByRole('button', { name: /Add manually/ }).click();
  await page.getByLabel('Name').fill('Wrong code');
  await page.getByLabel(/^Model/).selectOption('P1S');
  await page.getByLabel('IP address').fill(FAKE_PRINTER.ip);
  await page.getByLabel('Serial number').fill('01P00A000000099');
  await page.getByLabel('Access code').fill('00000000');
  await page.getByLabel(/Verify printer certificate/).uncheck();
  await page.getByRole('button', { name: 'Add printer' }).click();
  await expect(page.getByText(/Wrong access code/)).toBeVisible();
  await expect(page).toHaveURL(/#\/add$/);
});
