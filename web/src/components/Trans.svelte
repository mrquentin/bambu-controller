<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t, type MessageKey } from '../lib/i18n.svelte';

  /**
   * A message with markup inside: each `{name}` placeholder is rendered by the
   * snippet of the same name, so translations never go through {@html}.
   *
   *   <Trans key="job.noActive">{#snippet files()}<b>{t('printer.tabFiles')}</b>{/snippet}</Trans>
   */
  let { key, ...snippets }: { key: MessageKey; [name: string]: unknown } = $props();

  const parts = $derived(t(key).split(/(\{\w+\})/));
  const snippetFor = (part: string) => (/^\{\w+\}$/.test(part) ? (snippets[part.slice(1, -1)] as Snippet | undefined) : undefined);
</script>

{#each parts as part}{@const snippet = snippetFor(part)}{#if snippet}{@render snippet()}{:else}{part}{/if}{/each}
