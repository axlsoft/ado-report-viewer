function formatCurrency(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { currency, style: "currency" }).format(amount);
}

function truncate(text, length) {
  if (text.length <= length) {
    return text;
  }
  return `${text.slice(0, length - 1)}…`;
}

module.exports = { formatCurrency, truncate };
