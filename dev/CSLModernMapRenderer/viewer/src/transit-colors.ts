const darkText = '#17202a';
const lightText = '#fff';
const darkTextMinLuminance = .52;

function luminance(hex: string): number {
  let digits = hex.replace(/^#/, '');
  if (/^[\da-f]{3}$/i.test(digits)) digits = [...digits].map(digit => digit.repeat(2)).join('');
  if (!/^[\da-f]{6}$/i.test(digits)) return 0;
  return [.2126, .7152, .0722].reduce((sum, weight, index) => {
    const channel = parseInt(digits.slice(index * 2, index * 2 + 2), 16) / 255;
    const linear = channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    return sum + weight * linear;
  }, 0);
}

export function transitContrastText(background: string): string {
  return luminance(background) >= darkTextMinLuminance ? darkText : lightText;
}
