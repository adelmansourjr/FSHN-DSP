# Firebase Rules Test Report

Generated: 2026-04-03T20:59:18.262Z

Summary: total=16; passed=16; failed=0

| Check | Result | Notes |
| --- | --- | --- |
| Unauthenticated clients cannot create user profiles | Checked and working |  |
| Unauthenticated clients cannot upload profile pictures | Checked and working |  |
| Users cannot change date of birth after profile creation | Checked and working |  |
| Users cannot change username through direct profile writes | Checked and working |  |
| Counterfeit followersCount updates are rejected | Checked and working |  |
| Counterfeit listing likeCount updates are rejected | Checked and working |  |
| Valid batched follow edge writes can increment followersCount | Checked and working |  |
| Valid batched liker edge writes can increment listing likeCount | Checked and working |  |
| Seller clients cannot write moderation removal fields on listings | Checked and working |  |
| Blocked users cannot read each other’s profile documents | Checked and working |  |
| Blocked users cannot read blocked profile pictures from Storage | Checked and working |  |
| Clients cannot write Stripe customer state documents | Checked and working |  |
| Clients cannot create checkout session documents directly | Checked and working |  |
| Clients cannot create order documents directly | Checked and working |  |
| Buyers cannot forge seller-only shipment state transitions | Checked and working |  |
| Sellers can perform the allowed paid-to-shipped transition | Checked and working |  |

