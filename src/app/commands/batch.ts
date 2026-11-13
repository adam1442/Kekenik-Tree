import type { Command } from '@/contracts/app';

/** Several commands as ONE history entry (undo runs in reverse order). */
export function batch(label: string, commands: Command[]): Command {
  return {
    label,
    do(): void {
      for (const c of commands) c.do();
    },
    undo(): void {
      for (let i = commands.length - 1; i >= 0; i--) (commands[i] as Command).undo();
    },
  };
}
