// Exercises part of the library so the coverage report has covered and uncovered lines.
const assert = require("node:assert/strict");
const { cartTotal, describeCart } = require("./lib/pricing/cart.cjs");

assert.equal(cartTotal([{ price: 5, quantity: 2 }]), 10);
assert.equal(describeCart([{ price: 5, quantity: 2 }]), "1 items, $10.00");
