import { isTauri, showBrowserContextMenu } from "../lib/bridge";

export interface ContextMenuItem {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Show a native OS context menu at the current cursor position.
 * Pass `null` in the items array to insert a separator.
 */
export async function showContextMenu(
  _x: number,
  _y: number,
  items: (ContextMenuItem | null)[]
) {
  if (!isTauri) {
    return showBrowserContextMenu(items);
  }

  const { Menu, MenuItem, PredefinedMenuItem } = await import(
    "@tauri-apps/api/menu"
  );

  const menuItems = await Promise.all(
    items.map(async (item) => {
      if (item === null) {
        try {
          return await PredefinedMenuItem.new({ item: "Separator" });
        } catch {
          return null;
        }
      }
      const handler = item.onClick;
      return MenuItem.new({
        text: item.label,
        enabled: !item.disabled,
        action: () => handler(),
      });
    })
  );

  const menu = await Menu.new({ items: menuItems.filter((i): i is NonNullable<typeof i> => i != null) });
  await menu.popup();
}

/**
 * Pre-warm the context menu system at app startup by creating a dummy Menu
 * to initialise the Tauri IPC channel.
 */
export async function prewarmContextMenu(): Promise<void> {
  if (!isTauri) return;
  try {
    const { Menu } = await import("@tauri-apps/api/menu");
    await Menu.new({ items: [] });
  } catch {
    // best-effort — failure here must not affect app startup
  }
}
