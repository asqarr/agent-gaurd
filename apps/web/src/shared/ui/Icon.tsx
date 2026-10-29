export type IconName =
  | "grid"
  | "bot"
  | "scan"
  | "library"
  | "wallet"
  | "shield"
  | "plug"
  | "search"
  | "bell"
  | "plus"
  | "arrow"
  | "chevron"
  | "activity"
  | "sparkle"
  | "lock"
  | "unlock"
  | "clock"
  | "settings";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    bot: "M12 3v3m-4 2h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3Zm-3 4h.01M15 12h.01M9 16h6",
    scan: "M4 7V5a1 1 0 0 1 1-1h2m9 0h2a1 1 0 0 1 1 1v2m0 10v2a1 1 0 0 1-1 1h-2m-9 0H5a1 1 0 0 1-1-1v-2M8 12h8m-4-4v8",
    library: "M5 5h14v14H5zM8 9h8M8 12h8M8 15h5",
    wallet: "M4 7h16v12H4zM4 7V5h13v2m3 5h-4a2 2 0 0 0 0 4h4m0-4v4",
    shield: "M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Zm-3 9 2 2 4-4",
    plug: "M8 12h8M10 7V4m4 3V4m-6 7a4 4 0 0 0 8 0V9H8v2Zm4 4v7",
    search: "m20 20-4.5-4.5M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z",
    bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4",
    plus: "M12 5v14M5 12h14",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    chevron: "m9 18 6-6-6-6",
    activity: "M3 12h4l2-8 4 16 2-8h6",
    sparkle: "m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 11 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z",
    lock: "M6 10V8a6 6 0 0 1 12 0v2m-13 0h14v10H5V10Zm7 4v2",
    unlock: "M7 10V8a5 5 0 0 1 9.5-2M5 10h14v10H5V10Zm7 4v2",
    clock: "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M3 12h2m14 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42",
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
