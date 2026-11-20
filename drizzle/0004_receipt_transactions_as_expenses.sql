-- Scanned receipts used to be saved with a positive amount, which the app
-- treats as income. Receipts are always purchases: store them as expenses.
UPDATE "transactions" SET "amount_minor" = -"amount_minor" WHERE "source" = 'receipt' AND "amount_minor" > 0;
