/**
 * A count as a badge shows it. Past 99 it is "99+": a four-digit count overflowed the 36px tile and
 * covered the icon, and nobody acts differently on 1,204 than on 99.
 */
export const badgeText = (count: number): string => (count > 99 ? '99+' : String(count));
