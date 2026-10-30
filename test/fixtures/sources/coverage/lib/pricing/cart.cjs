const { formatCurrency } = require("../text/format.cjs");

function cartTotal(items, discount = 0) {
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
  if (discount > 0) {
    return Math.max(0, subtotal - discount);
  }
  return subtotal;
}

function describeCart(items) {
  if (items.length === 0) {
    return "Your cart is empty";
  }
  return `${items.length} items, ${formatCurrency(cartTotal(items))}`;
}

module.exports = { cartTotal, describeCart };
