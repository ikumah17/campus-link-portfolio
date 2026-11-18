import { setup } from "./lifecycle";
import { cleanupStorageFixtures } from "./teardown";

// TEST-014: an interrupted storage run's recorded objects go first, before the previous ledger's user cleanup.
export default async function globalSetup() {
  await cleanupStorageFixtures();
  await setup();
}
