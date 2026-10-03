/**
 * Every field a customer can submit is validated here with zod before any
 * route handler touches it. Nothing from req.body is trusted or used
 * unvalidated — invalid input is rejected with a 400 and a plain-language
 * message, never silently coerced or passed through.
 */
const { z } = require("zod");

const name = z.string().trim().min(1, "Please enter a name.").max(80);
const phone = z
  .string()
  .trim()
  .regex(/^\d{10}$/, "Please enter a 10-digit mobile number.");
const email = z.string().trim().email("Please enter a valid email address.").max(200).optional().or(z.literal(""));
const pincode = z.string().trim().regex(/^\d{6}$/, "Please enter a 6-digit pincode.");
const shortText = (maxLen, label) =>
  z.string().trim().min(1, `Please enter ${label}.`).max(maxLen, `${label} is too long.`);

const customerSchema = z.object({
  name,
  phone,
  email: email.optional(),
});

const addressSchema = z.object({
  house: shortText(120, "the house / flat number"),
  street: shortText(160, "the street"),
  area: shortText(120, "the area"),
  city: shortText(80, "the city"),
  pincode,
  landmark: z.string().trim().max(160).optional().or(z.literal("")),
});

const cartItemSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  qty: z.number().int().min(1).max(20),
  // The frontend cart (public/js/state.js) explicitly stores `null` — not
  // `undefined` — for a line with no variant, so this must accept both.
  variantLabel: z.string().trim().max(60).nullable().optional(),
});

const checkoutSchema = z.object({
  customer: customerSchema,
  address: addressSchema,
  items: z.array(cartItemSchema).min(1, "Your cart is empty.").max(30),
  deliveryOption: z.enum(["home-delivery"]).default("home-delivery"),
  // Online payment only — there is deliberately no cash/pay-later option.
  // Which online method (Razorpay or demo) is the server's choice, from its
  // own config — see server/payments/paymentConfig.js. "upi" is the old form
  // value, still accepted from pages cached before the rename.
  paymentMethod: z.enum(["online", "upi"], { errorMap: () => ({ message: "Please choose an online payment method." }) }),
  // Proof the customer controls customer.phone (WhatsApp one-time code).
  // Required whenever this deployment can send codes — see routes/checkout.js.
  phoneVerificationToken: z.string().trim().max(200).optional(),
});

const deliveryQuoteSchema = z.object({
  address: addressSchema,
});

const aiGuideSchema = z.object({
  message: z.string().trim().min(1, "Please type a question.").max(400),
  productId: z.string().trim().max(80).optional(),
});

const customEnquirySchema = z.object({
  name,
  occasion: shortText(120, "the occasion"),
  // <input type="date"> value; optional — the customer may not have a date yet.
  preferredDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Please pick a valid date.")
    .optional()
    .or(z.literal("")),
  size: z.string().trim().max(80).optional().or(z.literal("")),
  flavor: z.string().trim().max(120).optional().or(z.literal("")),
  message: z.string().trim().max(300).optional().or(z.literal("")),
  phone,
  budget: z.string().trim().max(60).optional().or(z.literal("")),
});

/**
 * Express middleware factory: validates req.body against `schema`, replaces
 * req.body with the parsed (trimmed/coerced) result, or responds 400 with a
 * safe, non-leaking error message.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      return res.status(400).json({ error: first ? first.message : "Invalid request." });
    }
    req.body = result.data;
    next();
  };
}

module.exports = {
  phone,
  customerSchema,
  addressSchema,
  cartItemSchema,
  checkoutSchema,
  deliveryQuoteSchema,
  aiGuideSchema,
  customEnquirySchema,
  validateBody,
};
