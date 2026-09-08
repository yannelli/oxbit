/** Use the supplied brand artwork so every app surface keeps the O and bit together. */
export function OxbitMark({
  className = "",
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <span
      className={`oxbit-mark ${className}`.trim()}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Oxbit"}
      aria-hidden={decorative || undefined}
    />
  );
}

export function OxbitLogo() {
  return <span className="oxbit-logo" role="img" aria-label="Oxbit" />;
}
