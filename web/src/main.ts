import { mount } from 'svelte';
import './lib/i18n.svelte'; // picks the UI language and sets <html lang> before the first render
import App from './App.svelte';
import './app.css';
import { registerServiceWorker } from './lib/push';

registerServiceWorker();

export default mount(App, { target: document.getElementById('app')! });
