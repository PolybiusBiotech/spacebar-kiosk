function money(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number.toFixed(2) : String(value ?? "");
}

function dateTime(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function line(text = "", width = 42) {
  return String(text).slice(0, width).padEnd(width, " ");
}

function wrap(text, width = 42) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

export function renderSlip(order) {
  const slip = order.slip ?? order;
  const title = slip.title ?? order.order_name ?? "Kiosk order";
  const lines = [
    "",
    line(title.toUpperCase()),
    line("UNPAID - PAY AT THE TILL"),
    line("-".repeat(42)),
    line(`Created: ${dateTime(slip.created_at ?? order.created_at)}`),
    line(`Expires: ${dateTime(slip.expires_at ?? order.expires_at)}`),
    line("-".repeat(42))
  ];

  for (const item of slip.lines ?? []) {
    lines.push(...wrap(item.description));
    const qty = String(item.quantity ?? "");
    const unit = money(item.unit_price);
    const total = money(item.line_total);
    lines.push(line(`${qty} x GBP ${unit}`.padEnd(28, " ") + `GBP ${total}`));
  }

  lines.push(line("-".repeat(42)));
  lines.push(line(`TOTAL`.padEnd(28, " ") + `GBP ${money(slip.total ?? order.total)}`));
  lines.push("");
  lines.push(line("Take this slip to a human-operated till."));
  lines.push(line("Order is not paid until staff complete it."));
  lines.push("");
  lines.push("");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
