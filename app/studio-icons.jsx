export function Mark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 40" width="38" height="32">
      <path
        fill="currentColor"
        d="M12 4h35L36 14H23l-3 6h14L24 30h-9l-3 7H2z"
      />
    </svg>
  );
}

export function Icon({ name }) {
  const paths = {
    arrow: 'M4 12h15m-6-6 6 6-6 6',
    close: 'm6 6 12 12M18 6 6 18',
    tick: 'm4 12 5 5L20 6',
    ticket: 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4Zm12 2v2m0 4v2',
    clock: 'M12 2.8a9.2 9.2 0 1 1 0 18.4 9.2 9.2 0 1 1 0-18.4Zm0 4.7V12l3.5 2',
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
