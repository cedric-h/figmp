import { token, signingSecret } from "./auth.json";
import { BadInput, serialize, deserialize } from "./utils"
import { App } from '@slack/bolt';
import fs from 'fs';
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";

const ppcents = (cents: number) => `*${(cents/100).toFixed(2)}:sc:*`;
const ppfig = ({kind, id}: Figurine) => (kind == FigKind.Hacker) ? `<@${id}>` : `:${id}:`;
const sum = (l: number[]) => l.reduce((a, l) => a + l, 0);

const parseFig = (figTxt: string) => {
  let match;
  if (match = figTxt.match(/^:(.+):$/))
    return { kind: FigKind.Emoji, id: match[1] };
  else if (match = figTxt.match(/^<@([a-zA-Z0-9]+)(?:\|.+)?>$/))
    return { kind: FigKind.Hacker, id: match[1] };
  throw new BadInput("Expected ping or emoji, not: " + figTxt);
}

enum FigKind { Emoji = "emoji", Hacker = "hacker" }
type Figurine = { kind: FigKind, id: string };
type Sell = { seller: string, demandsCents: number, hook: string };
type Buy = { buyer: string, offersCents: number, hook: string };
type HistEntry = { date: number, user: string, cents: number };
type Market = { sells: Sell[], buys: Buy[], hist: HistEntry[] };

const marketfile = "../marketfile.json";
const market: Map<string, Market> = (() => {
  try {
    return deserialize(fs.readFileSync(marketfile, "utf-8"));
  } catch(e) {
    console.error("Couldn't read market file: " + e);
    return new Map();
  }
})();
const writeMarket = () => fs.writeFileSync(marketfile, serialize(market), "utf-8");
const getMarket = (_fig: Figurine): Market => {
  const fig = ppfig(_fig);
  market.set(fig, market.get(fig) ?? { sells: [], buys: [], hist: [] });
  return market.get(fig)!;
}

const ids = { ship: "C0M8PUPU6", ced: "UN971L2UQ", me: "U02PGHYHMK9" } as const;

const helpText = `:yay: figmp is a place to buy, sell, and approximate the value of digital hack club figurines in terms of the community run currency sc :sc:

\`/figmp faq\` - run this command to learn about why figs are cool and how figmp works
\`/figmp shop\` - see the cheapest and most sought after figurines
\`/figmp shop FIG\` - see how much people are buying and selling FIG for, or even buy/sell FIG
`;

const faqText = `*Frequently Asked Questions*:

*how do I get sc?* ship cool projects in <#${ids.ship}>, and then run \`/sc passgo\`! see \`/sc help\` for more info.

*how do I get figurines?* the same way you get sc! you get sc from the most popular reaction on each of your ships. reactions of a certain emoji give you a chance to get a figurine of that emoji. likewise, reactions from certain hackclubbers give you a chance to get their figurine.

*what are figurines good for?* aside from the novelty, they can earn you extra sc on your ships! if you have a figurine of <@${ids.ced}> (cool guy btw), and he reacts to your ship, you get *+5:sc:* extra. likewise, if you have the :yay: figurine and the most popular reaction on your ship is :yay:, you get between *+0.35:sc:* and *+0.45:sc:* for each :yay: reaction your ship receives. note that these apply only when you run \`sc passgo\`.

*what are sell orders?* if you have a figurine you want to sell, you can send it to figmp along with a price, and figmp will keep advertising it at that price until somebody buys it. or, you can revoke your sell order whenever you like.

*what are buy orders?* maybe you want to buy a figurine, but nobody is selling one yet, or not for a price you can afford, anyway. if you send figmp however much you CAN afford, it will advertise that you're willing to pay that much, and someone with that figurine can immediately sell it toyou for that price. you can revoke your buy orders whenever you like.

*how do I make buy or sell orders?* through the sell/buy UI associated with \`/figmp shop FIG\`, where FIG is the emoji or slack ping your figurine represents.
`;

enum Style { Danger = "danger", Primary = "primary", Plain = "plain" };
const buttonBlock = ({text, action_id, value, style}: {
  text: string,
  action_id: string,
  value: string,
  style?: Style
}) => {
  const ret: any = {
    "type": "button",
    "text": { "type": "plain_text", "emoji": true, text },
    action_id,
    value,
  };
  if (style && style != Style.Plain)
    ret["style"] = "" + style;
  return ret;
}

const figShopPage = (figTxt: string) => {
  let text = "";
  const blocks: any = [];
  const buttons: any = [];
  const fig = parseFig(figTxt);
  const mkt = getMarket(fig);

  mkt.sells.sort((a, b) => a.demandsCents - b.demandsCents);
  mkt.buys.sort((a, b) => b.offersCents - a.offersCents);

  text += `*The ${ppfig(fig)} Figurine!*`;
  (() => {
    const { sells } = mkt;
    const topSells = sells.slice(0, 5).map(b => ppcents(b.demandsCents));
    text += '\n' + ((sells.length > 0)
      ? `${sells.length} for sale starting at: *${topSells.join(", ")}*`
      : `No ${ppfig(fig)} figurines for sale, yet!`);
    buttons.push(buttonBlock({
      text: "Sell",
      action_id: "fig_sell",
      value: figTxt,
      style: Style.Danger
    }));
    if (sells.length)
      buttons.push(buttonBlock({
        text: `Sell Now (${topSells[0]}:sc:)`,
        action_id: 'fig_sell_now',
        value: figTxt,
        style: Style.Danger
      }));
  })();

  (() => {
    const { buys } = mkt;
    const topBuys = buys.slice(0, 5).map(b => ppcents(b.offersCents));
    text += '\n' + ((buys.length > 0)
      ? `${buys.length} buy orders starting at: *${topBuys.join(", ")}*`
      : `No ${ppfig(fig)} figurine buy orders, yet!`);

    buttons.push(buttonBlock({
      text: "Buy",
      action_id: "fig_buy",
      value: figTxt,
      style: Style.Primary
    }));
    if (buys.length)
      buttons.push(buttonBlock({
        text: `Buy Now (${topBuys[0]}:sc:)`,
        action_id: 'fig_buy',
        value: figTxt,
        style: Style.Primary
      }));
  })();

  if (mkt.hist.length) {
    const { hist } = mkt;
    const totalWorth = sum(hist.map(x => x.cents));
    const frequentTraders = (() => {
      const map = hist.reduce(
        (acc, h) => acc.set(h.user, (acc.get(h.user) ?? 0) + 1),
        new Map()
      );
      return ([...map] as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .map(([usr, amt]) => `<@${usr}> (*${(100 * amt/hist.length).toFixed(0)}%*)`);
    })();
    text += `\nHistorically, ${hist.length} of this figurine have sold for` +
      ` on average, ${ppcents(totalWorth/hist.length)}.\nAcross all transactions` +
      ` users have spent ${ppcents(totalWorth)} on figurines of this type.` +
      '\nUsers who have been involved in many transactions of this figurine: ' +
      frequentTraders.slice(0, 3).join(", ");
  }

  blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
  blocks.push({ "type": "actions", "elements": buttons });
  return { text, blocks };
}

const app = new App({ token: token.bot, signingSecret });
(async () => {
  await app.start(3001);

  app.action("fig_buy", async ({ ack, respond, action }) => {
    await ack();
    const { value: figTxt } = action as any;
    const { blocks } = figShopPage(figTxt);
    const text = `Enter */sc pay <@${ids.me}> 50 for ${figTxt}*, for example` +
      `, if you want to offer ${ppcents(5000)} for this figurine.`;
    blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });

    return await respond({ text, blocks });
  });

  app.command('/figmp', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();
    const [cmd, figTxt] = command.text.trim().split(/\s+/);

    switch (cmd) {
      case "shop":
        if (figTxt) return await respond(figShopPage(figTxt));

        const blocks: any = [];
        let text = "";
        text += ":yay: *Welcome to figmp* :yay:";
        const entries = [...market.entries()];
        const sells = entries.map(([fig, m]) => m.sells.map(s => [fig, s] as const)).flat();
        const buys = entries.map(([fig, m]) => m.buys.map(b => [fig, b] as const)).flat();
        const hist = entries.map(([fig, m]) => m.hist.map(h => [fig, h] as const)).flat();
        
        const allDemanded = ppcents(sum(sells.map(([, s]) => s.demandsCents)));
        const allOffered = ppcents(sum(buys.map(([, b]) => b.offersCents)));
        text += `\nIn total, there are ${sells.length} figs for sale demanding ${allDemanded}`;
        text += `\nMeanwhile, there are ${buys.length} buy orders out offering ${allOffered}`;
        text += `\nHistorically, ${hist.length} figs have been traded on figmp` +
          " worth a total of " + ppcents(sum(hist.map(([, h]) => h.cents)));
        text += '\n';

        if (sells.length) {
          const lowestPrice = (m: Sell[]) => Math.min(...m.map(x => x.demandsCents));
          entries.sort(([, {sells: a}], [, {sells: b}]) => lowestPrice(a) - lowestPrice(b));
          text += "\nSome of the cheapest figs for sale include: " +
            entries.slice(0, 5).map(([f]) => f).join(', ');
        }

        if (buys.length) {
          const highestOffer = (m: Buy[]) => Math.max(...m.map(x => x.offersCents));
          entries.sort(([, {buys: a}], [, {buys: b}]) => highestOffer(a) - highestOffer(b));
          text += "\nUsers are offering the most for these figs: " +
            entries.slice(0, 5).map(([f]) => f).join(', ');
        }

        if (hist.length) {
          text += "\n";
          entries.sort(([, {hist: a}], [, {hist: b}]) => hist.length - hist.length);
          text += "\nHistorically, these figs have been frequent fliers: " +
            entries.slice(0, 5).map(([f]) => f).join(', ');
          const histWorth = (h: HistEntry[]) => sum(h.map(x => x.cents));
          entries.sort(([, {hist: a}], [, {hist: b}]) => histWorth(a) - histWorth(b));
          text += "\nHistorically, these figs have sold for a lot: " +
            entries.slice(0, 5).map(([f]) => f).join(', ');
        }
        blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
        return await respond({ text, blocks });
      case "faq":
        return await respond(faqText);
      default: 
        return await respond(helpText);
    }

    await respond("ur mom gay");
  }));

  function forwardErrToUser(fn: (args: SlackCommandMiddlewareArgs) => Promise<any>) {
    return async (args: SlackCommandMiddlewareArgs) => {
      fn(args).catch(e => args.respond(
        (e instanceof BadInput)
          ? ("Bad Input: " + e.message)
          : (console.error(e), "Bot Internals: " + e)
      ));
    }
  }

  console.log('⚡️ Bolt app is running!');
})();
