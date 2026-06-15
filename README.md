# Speakeasy Kiosk

Customer-facing Raspberry Pi touchscreen kiosk for creating unpaid drink orders
in tillweb. The kiosk shows stock for one configured till location, sends the
basket to tillweb, prints the returned unpaid order slip locally, and shows the
customer the order number to take to a human-operated till.

## Runtime Shape

- A dependency-free Node.js server serves the kiosk UI on localhost.
- The browser never sees the tillweb bearer token; the local server proxies API
  calls to tillweb.
- Slips print through CUPS using `lp` by default.
- Raspberry Pi kiosk mode is handled with systemd services for the server and
  Chromium.
- The UI is designed for a portrait touchscreen, with products above and the
  running basket plus `Confirm order` action fixed at the bottom of the screen.

## Local Development

```sh
cp .env.example .env
$EDITOR .env
npm start
```

For local UI work without a printer, set:

```sh
KIOSK_PRINT_ENABLED=false
KIOSK_MOCK_MODE=true
```

Then open `http://127.0.0.1:8080`.

## Raspberry Pi Install

On Raspberry Pi OS with Node.js 20+, Chromium, CUPS, and a configured printer:

```sh
sudo ./ops/install-pi.sh
sudoedit /etc/speakeasy-kiosk.env
sudo systemctl restart speakeasy-kiosk.service speakeasy-kiosk-browser.service
```

Required settings:

- `TILLWEB_BASE_URL`: tillweb base URL, such as `https://till.example.org`.
- `TILLWEB_KIOSK_TOKEN`: bearer token from `TILLWEB_KIOSK_API_TOKENS`.
- `KIOSK_LOCATION`: tillweb stock/order location, default `Kiosk`.

Useful optional settings:

- `KIOSK_ORDER_PREFIX`: label shown in the UI, defaulting to the location.
- `KIOSK_PRINTER_NAME`: CUPS printer name. Blank uses the default printer.
- `KIOSK_PRINT_COMMAND`: `lp` or `lpr`.
- `KIOSK_PORT`: local HTTP port, default `8080`.

## Operations

Check status:

```sh
systemctl status speakeasy-kiosk.service
systemctl status speakeasy-kiosk-browser.service
```

Read logs:

```sh
journalctl -u speakeasy-kiosk.service -f
journalctl -u speakeasy-kiosk-browser.service -f
```

Health check:

```sh
curl http://127.0.0.1:8080/healthz
```

## Customer Flow

Customers tap drinks to add them to the running basket at the bottom of the
screen, adjust quantities there, then press `Confirm order`. The kiosk creates
an unpaid order in tillweb, prints the order slip, and shows the order number.

If stock changes while the customer is ordering, the kiosk refreshes the product
list and asks them to review the basket. If the order is created but printing
fails, the kiosk shows a staff/help state and does not create another order.
