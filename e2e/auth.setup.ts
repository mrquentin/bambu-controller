import { test as setup, expect } from '@playwright/test';
import { ADMIN } from './fixtures.ts';

/**
 * Runs first against the fresh server: creates the admin through the first-run
 * screen, logs out and back in, then saves the session for the other tests
 * (login is rate limited, so the tests don't each sign in).
 */
setup('first-run setup creates the admin, then logout and login work', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Create the first account')).toBeVisible();

  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByLabel('Confirm password').fill('Something-Else-42');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Passwords do not match')).toBeVisible();

  await page.getByLabel('Confirm password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Printers', level: 1 })).toBeVisible();
  await expect(page.getByText(ADMIN.username, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Confirm password')).toHaveCount(0);

  // Wrong password first, then the right one.
  await page.getByLabel('Username').fill(ADMIN.username);
  await page.getByLabel('Password').fill('Not-The-Password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid username or password')).toBeVisible();

  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Printers', level: 1 })).toBeVisible();

  // A reload keeps the session.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();

  await page.context().storageState({ path: 'test-results/.auth/admin.json' });
});
