/** Etsy's orange badge with its "E", for buttons that leave the app for Etsy. */
export default function EtsyMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="16" height="16" rx="3.5" fill="#F1641E" />
      <path
        fill="#fff"
        d="M5.1 3.9h6.1v2.2h-1.1l-.2-1.1H7.3v2.5h2.3v1.2H7.3v2.6h2.8l.3-1.3h1.1l-.2 2.4H5.1v-1.1h.9V5h-.9z"
      />
    </svg>
  );
}
