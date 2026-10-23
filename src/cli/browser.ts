import { spawn } from 'node:child_process';

/** Opens a URL in the default browser; quietly does nothing where there is none (the caller prints the URL too). */
export function openBrowser(url: string): void {
  const [cmd, cmdArgs]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // browserless environment — the printed URL covers it
  }
}
