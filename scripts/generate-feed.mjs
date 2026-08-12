#!/usr/bin/env node
/**
 * Generates a Google Shopping product feed (CSV) for ohooj.com (DE/EUR market)
 * by reading products + fixed EUR prices from the Shopify "EU/DE EUR Prislista" price list.
 *
 * Required environment variables:
 *   SHOPIFY_STORE_DOMAIN   e.g. dpygnb-15.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN    Admin API access token (custom app, read_products + read_markets scopes)
 *   SHOPIFY_PRICE_LIST_ID  e.g. gid://shopify/PriceList/33990574419
 *
 * Optional:
 *   STORE_URL       default https://ohooj.com
 *   API_VERSION     default 2025-01
 *   OUTPUT_PATH     default docs/google_shopping_eu_de.csv
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_PRICE_LIST_ID,
  STORE_URL = "https://ohooj.com",
  API_VERSION = "2025-01",
  OUTPUT_PATH = "docs/google_shopping_eu_de.csv",
} = process.env;

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN || !SHOPIFY_PRICE_LIST_ID) {
  console.error(
    "Missing required environment variables. Need SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, SHOPIFY_PRICE_LIST_ID."
  );
  process.exit(1);
}

const GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const QUERY = `
  query PriceListPrices($priceListId: ID!, $first: Int!, $after: String) {
    priceList(id: $priceListId) {
      prices(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          price { amount currencyCode }
          compareAtPrice { amount }
          variant {
            id
            sku
            barcode
            availableForSale
            inventoryQuantity
            selectedOptions { name value }
            image { url }
            product {
              id
              title
              handle
              status
              vendor
              productType
              descriptionHtml
              tags
              featuredImage { url }
            }
          }
        }
      }
    }
  }
`;

async function fetchPage(after) {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { priceListId: SHOPIFY_PRICE_LIST_ID, first: 100, after },
    }),
  });

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data.priceList.prices;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5000);
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function numericId(gid) {
  return gid.split("/").pop();
}

function looksLikeGtin(code) {
  return !!code && /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(code.trim());
}

async function main() {
  const rows = [];
  let after;
  let pageCount = 0;

  while (true) {
    const page = await fetchPage(after);
    pageCount += 1;
    console.log(`Fetched page ${pageCount} (${page.nodes.length} variants)`);

    for (const node of page.nodes) {
      const variant = node.variant;
      const product = variant.product;

      if (product.status !== "ACTIVE") continue;

      const variantId = numericId(variant.id);
      const productId = numericId(product.id);
      const price = node.price;
      const image = variant.image?.url || product.featuredImage?.url || "";
      const availability = variant.availableForSale ? "in_stock" : "out_of_stock";
      const gtin = looksLikeGtin(variant.barcode) ? variant.barcode.trim() : "";
      const optionSuffix = (variant.selectedOptions || [])
        .filter((o) => o.value && o.value.toLowerCase() !== "default title")
        .map((o) => o.value)
        .join(" ");
      const title = optionSuffix ? `${product.title} - ${optionSuffix}` : product.title;

      rows.push({
        id: variantId,
        item_group_id: productId,
        title,
        description: stripHtml(product.descriptionHtml) || title,
        link: `${STORE_URL}/products/${product.handle}?variant=${variantId}`,
        image_link: image,
        availability,
        price: `${Number(price.amount).toFixed(2)} ${price.currencyCode}`,
        brand: product.vendor || "Ohooj",
        condition: "new",
        gtin,
        identifier_exists: gtin ? "yes" : "no",
        mpn: variant.sku || "",
      });
    }

    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }

  const headers = [
    "id",
    "item_group_id",
    "title",
    "description",
    "link",
    "image_link",
    "availability",
    "price",
    "brand",
    "condition",
    "gtin",
    "identifier_exists",
    "mpn",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  const csv = lines.join("\n") + "\n";

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, csv, "utf8");

  console.log(`Wrote ${rows.length} products to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
