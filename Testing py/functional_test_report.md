# Functional Test Report

Generated: 2026-04-03 22:45:32 EET

Summary: total=14; pass=4; blocked_external_permission=0; requires_live_validation=8; fail=2

## Area Summary

| Area | Status | Checks | Breakdown |
| --- | --- | --- | --- |
| Firebase security rules | PASS | 1 | pass=1; blocked=0; live=0; fail=0 |
| Harness | FAIL | 2 | pass=0; blocked=0; live=1; fail=1 |
| Authentication and profile persistence | REQUIRES_LIVE_VALIDATION | 2 | pass=1; blocked=0; live=1; fail=0 |
| Listing creation and browsing | REQUIRES_LIVE_VALIDATION | 2 | pass=1; blocked=0; live=1; fail=0 |
| Post publishing and feed display | REQUIRES_LIVE_VALIDATION | 2 | pass=1; blocked=0; live=1; fail=0 |
| Wardrobe item creation and tagging | REQUIRES_LIVE_VALIDATION | 1 | pass=0; blocked=0; live=1; fail=0 |
| Prompt recommendation outputs for multiple prompt types | FAIL | 1 | pass=0; blocked=0; live=0; fail=1 |
| Try-on generation for each supported role | REQUIRES_LIVE_VALIDATION | 1 | pass=0; blocked=0; live=1; fail=0 |
| Cart assembly and sandbox checkout handoff | REQUIRES_LIVE_VALIDATION | 1 | pass=0; blocked=0; live=1; fail=0 |
| Blocking behaviour and access denial | REQUIRES_LIVE_VALIDATION | 1 | pass=0; blocked=0; live=1; fail=0 |

## Detailed Results

| Check | Area | Method | Status | Summary | Evidence | Details |
| --- | --- | --- | --- | --- | --- | --- |
| Firebase Security Rules Suite | Firebase security rules | executed | PASS | Emulator-backed Firestore and Storage rules checks covered unauthenticated writes, immutable fields, counterfeit counters, blocked access, and payment-state protection. | 16/16 rule checks passed. | All rules checks passed. |
| Compile Runnable Logic Modules | Harness | executed | FAIL | Failed to compile runnable TypeScript logic modules. | shippingAddress.ts, listingEditor.ts, feedRanking.ts | src/data/catalog.ts(2,33): error TS2732: Cannot find module './index.json'. Consider using '--resolveJsonModule' to import module with '.json' extension. src/data/catalog.ts(3,33): error TS2732: Cannot find module './... |
| Shipping Address Logic | Authentication and profile persistence | executed | PASS | Shipping address sanitization, completeness gating, equality, and formatting behaved as expected. | {"completeOk":true,"incompleteOk":false,"equalOk":true,"formatted":"1 Main • London, SW1A • UK"} |  |
| Listing Editor Normalization Logic | Listing creation and browsing | executed | PASS | Listing editor state cloning trimmed fields, de-duplicated tags, and detected meaningful listing content. | {"emptyHasContent":false,"filledHasContent":true,"title":"Jacket","tags":["Denim","Blue"],"remotePhoto":true} |  |
| Feed Ranking Logic | Post publishing and feed display | executed | PASS | Feed ranking updated impression and like state, then ranked the stronger liked post first. | {"ranked":["p1","p2"],"postRecords":2,"authorRecords":2} |  |
| Live Service Checks | Harness | executed | REQUIRES_LIVE_VALIDATION | Live HTTP smoke checks were skipped. Run with --live to exercise local service routes. | Skipped by flag |  |
| Auth and Profile Wiring | Authentication and profile persistence | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Sign-in, sign-up, profile creation, and profile update wiring are present in app code. | src/context/AuthContext.tsx:4, src/context/AuthContext.tsx:6, src/lib/firebaseUsers.ts:253, src/lib/firebaseUsers.ts:257 | All anchors found, but the full flow still needs live integration coverage. |
| Wardrobe Creation and Tagging Wiring | Wardrobe item creation and tagging | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Closet persistence, classifier tagging, and upload auto-fill hooks are wired. | src/screens/ProfileScreen.tsx:72, src/screens/ProfileScreen.tsx:73, src/utils/localClassifier.ts:115, src/screens/UploadScreen.tsx:409 | All anchors found, but the full flow still needs live integration coverage. |
| Prompt Recommendation Wiring | Prompt recommendation outputs for multiple prompt types | source-anchor | FAIL | Prompt recommendation client and local recommender route are wired. | src/utils/localRecommender.ts:36, src/screens/StudioScreen.tsx:missing, tryon-local/serve.mjs:3229 | One or more expected implementation anchors were missing. |
| Try-On Pipeline Wiring | Try-on generation for each supported role | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Supported try-on roles and the client-to-server pipeline are wired. | src/tryon/types.ts:2, src/tryon/TryOnEngine.ts:169, src/tryon/providers/googleTryOn.ts:139, tryon-local/serve.mjs:3575 | All anchors found, but the full flow still needs live integration coverage. |
| Listing Publish Wiring | Listing creation and browsing | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Listing creation, update, and browse queries are wired. | src/lib/firebaseListings.ts:133, src/lib/firebaseListings.ts:167, src/screens/UploadScreen.tsx:581, src/screens/HomeScreen.tsx:234 | All anchors found, but the full flow still needs live integration coverage. |
| Cart and Hosted Checkout Wiring | Cart assembly and sandbox checkout handoff | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Basket persistence and checkout handoff wiring are present. | src/context/CartContext.tsx:213, src/context/CartContext.tsx:210, src/screens/BasketScreen.tsx:448, src/screens/BasketScreen.tsx:476, server/index.js:2417 | All anchors found, but the full flow still needs live integration coverage. |
| Post Publish and Feed Wiring | Post publishing and feed display | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Try-on posting and feed ranking/display wiring are present. | src/lib/firebasePosts.ts:192, src/components/ResultModal.tsx:425, src/screens/FeedScreen.tsx:1398, src/lib/feedRanking.ts:398 | All anchors found, but the full flow still needs live integration coverage. |
| Blocking and Access Filtering Wiring | Blocking behaviour and access denial | source-anchor | SOURCE_CONFIRMED_REQUIRES_LIVE_VALIDATION | Blocking mutations and blocked-user filtering are present. | src/lib/postModeration.ts:195, src/lib/postModeration.ts:199, src/screens/FeedScreen.tsx:1373, src/screens/UserProfileScreen.tsx:812 | All anchors found, but the full flow still needs live integration coverage. |

## Notes

- `Method=executed` indicates a local harness or route-level check ran in this environment.
- `Method=source-anchor` indicates implementation anchors were found in source, but the full flow was not executed end to end.
- `Status=BLOCKED_EXTERNAL_PERMISSION` indicates the route ran but an external model/service permission blocked completion.
- `Evidence` contains captured response fragments, anchor locations, or serialized harness output.
