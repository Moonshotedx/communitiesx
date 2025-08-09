// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

// Check if Sentry should be enabled
const shouldEnableSentry =
  process.env.SENTRY_DISABLED !== "true" &&
  process.env.NODE_ENV !== "development";

if (shouldEnableSentry) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,
  })
} else {
  console.log("Sentry server initialization skipped")
}
