## Trade Dashboard

Simple JS dashboard for Kotak Neo trade APIs with:

- daily TOTP-based authentication
- place, modify, and cancel order actions
- order book, trade book, positions, holdings, and limits widgets

### Setup

1. Run `npm install`
2. Run `npm run dev`
3. Open the dashboard and save `consumer key`, `mobile number`, `UCC`, and `MPIN` from the UI
4. Authenticate with the current TOTP

The dashboard accepts TOTP from the auth card and stores credentials plus session data in a local SQLite database at `data/trade-dashboard.sqlite`. Session tokens are treated as valid only for the current India date.

### API Source

- Postman collection: `Client_AP_Is_postman_collection_82fa888c63.json`
- Documentation link: https://www.notion.so/Client-documentation-236da70d37e280b3a979fc7be7b003bc
