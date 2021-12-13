import fetch from 'node-fetch';
import { BadInput, serialize, deserialize } from "./utils.mjs"
import * as fs from 'fs';
import * as express from 'express';
const { App, ExpressReceiver } = (await import('@slack/bolt') as any).default as typeof import("@slack/bolt");
const { token, signingSecret, scalesToken } = deserialize(fs.readFileSync("./auth.json", "utf-8"));

const ppcents = (cents: number) => `*${(cents/100).toFixed(2)}:sc:*`;
const ppfig = ({kind, id}: Figurine) => (kind == FigKind.Hacker) ? `<@${id}>` : `:${id}:`;
const sum = (l: number[]) => l.reduce((a, l) => a + l, 0);

const fullIdRegex = /^<@([a-zA-Z0-9]+)(?:\|.+)?>$/;
const parseFig = (figTxt: string) => {
  let match;
  if (match = figTxt.match(/^:(.+):$/))
    return { kind: FigKind.Emoji, id: match[1] };
  else if (match = figTxt.match(fullIdRegex))
    return { kind: FigKind.Hacker, id: match[1] };
  throw new BadInput("Expected ping or emoji, not: " + figTxt);
}
export const stripId = (id: string) => {
  const match = id.match(fullIdRegex);
  if (match && match[1]) return match[1];
}

enum FigKind { Emoji = "emoji", Hacker = "hacker" }
type Figurine = { kind: FigKind, id: string };
type Sell = { seller: string, demandsCents: number, hookId: string, madeOn: number };
type Buy = { buyer: string, offersCents: number, hookId: string, madeOn: number };
type HistEntry = {
  finishedOn: number,
  startedOn: number,
  seller: string,
  buyer: string,
  buyerInitiated: boolean,
  cents: number
};
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

const ids = {
  ship: "C0M8PUPU6",
  ced: "UN971L2UQ",
  me: "U02PGHYHMK9",
  cia: "C02PS3FE8LX",
} as const;

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

*what are buy orders?* maybe you want to buy a figurine, but nobody is selling one yet, or not for a price you can afford, anyway. if you send figmp however much you CAN afford, it will advertise that you're willing to pay that much, and someone with that figurine can immediately sell it to you for that price. you can revoke your buy orders whenever you like.

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
      ? `${sells.length} for sale starting at: ${topSells.join(", ")}`
      : `No ${ppfig(fig)} figurines for sale, yet!`);
    buttons.push(buttonBlock({
      text: "Sell",
      action_id: "fig_sell",
      value: figTxt,
      style: Style.Danger
    }));
  })();

  (() => {
    const { buys } = mkt;
    const topBuys = buys.slice(0, 5).map(b => ppcents(b.offersCents));
    text += '\n' + ((buys.length > 0)
      ? `${buys.length} buy orders starting at: ${topBuys.join(", ")}`
      : `No ${ppfig(fig)} figurine buy orders, yet!`);

    buttons.push(buttonBlock({
      text: "Buy",
      action_id: "fig_buy",
      value: figTxt,
      style: Style.Primary
    }));
  })();

  if (mkt.hist.length) {
    const { hist } = mkt;
    const totalWorth = sum(hist.map(x => x.cents));
    const frequentTraders = (() => {
      const map = hist.reduce(
        (acc, h) => acc.set(h.seller, (acc.get(h.seller) ?? 0) + 1)
                       .set(h.buyer,  (acc.get(h.buyer ) ?? 0) + 1),
        new Map()
      );
      return ([...map] as [string, number][])
        .sort((a, b) => b[1] - a[1])
        .map(([usr, amt]) => `${usr} (*${(100 * amt/(hist.length*2)).toFixed(0)}%*)`);
    })();
    text += `\nHistorically, ${hist.length} of this figurine have sold for` +
      ` on average, ${ppcents(totalWorth/hist.length)}.\nAcross all transactions` +
      ` users have spent ${ppcents(totalWorth)} on figurines of this type.` +
      '\nUsers who have been involved in the most transactions of this figurine: ' +
      frequentTraders.slice(0, 3).join(", ");
  }

  blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
  blocks.push({ "type": "actions", "elements": buttons });
  return { text, blocks };
}

const figShopFrontPage = () => {
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
    text += "\nSome of the cheapest figs up for sale include: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');

    const mostRecent = (m: Sell[]) => Math.max(...m.map(x => x.madeOn));
    entries.sort(([, {sells: a}], [, {sells: b}]) => mostRecent(b) - mostRecent(a));
    text += "\nFigs most recently put up for sale: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');
  }

  if (buys.length) {
    const highestOffer = (m: Buy[]) => Math.max(...m.map(x => x.offersCents));
    entries.sort(([, {buys: a}], [, {buys: b}]) => highestOffer(b) - highestOffer(a));
    text += "\nUsers are offering the most for these figs: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');

    const mostRecent = (m: Buy[]) => Math.max(...m.map(x => x.madeOn));
    entries.sort(([, {buys: a}], [, {buys: b}]) => mostRecent(b) - mostRecent(a));
    text += "\nFigs users have recently put up offers to buy: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');
  }

  if (hist.length) {
    text += "\n";
    entries.sort(([, {hist: a}], [, {hist: b}]) => hist.length - hist.length);
    text += "\nHistorically, these figs have been frequent fliers: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');
    const histWorth = (h: HistEntry[]) => sum(h.map(x => x.cents));
    entries.sort(([, {hist: a}], [, {hist: b}]) => histWorth(b) - histWorth(a));
    text += "\nHistorically, these figs have sold for the most: " +
      entries.slice(0, 5).map(([f]) => f).join(', ');
  }

  blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
  return { text, blocks };
}

const receiver = new ExpressReceiver({ signingSecret});
const app = new App({ token: token.bot, receiver });

(() => {
  type exRequest = express.Request;
  type exResponse = express.Response;

  type ScalesRes = { ok: boolean, [k: string]: any };
  const sendScales = async (endpoint: string, json: any): Promise<ScalesRes> => {
    json.apiToken = scalesToken;
    const r = await fetch("https://misguided.enterprises/scales/api/" + endpoint, {
      method: 'post',
      body: serialize(json),
      headers: { "Content-Type": "application/json" }
    });
    return (await r.json().catch(e => ({ok: true}))) as ScalesRes;
  }

  /* unfortunately until Slack starts exposing a Express 5 Router, this lets us provide
   * a nicer API (esp. wrt. just throwing errors and knowing it'll catch them) than built-in
   * express error handlers */
  const errWrap = (fn: (req: exRequest, res: exResponse, next: any) => Promise<void>) => {
    return async (...args: [exRequest, exResponse, any]) => {
      return await fn(...args).catch(err => {
        const res = args[1];

        console.error(err);
        if (err instanceof BadInput)
          res.status(400);
        else
          res.status(500);
        res.send({ ok: false, error: err.message });
      });
    }
  };

  const { router } = receiver;
  router.use(express.json());
  router.post("/scales-endpoint", errWrap(async (req, res, next) => {
    console.log(req.path, req.body);

    switch (req.body.kind) {
      case "revokedHook": {
        const { hook, hookId } = req.body;

        const match = hook.desc.match(/(buying|selling for) (.*)/);
        if (!match) throw new BadInput("We don't output hook descs like: " + hook.desc);

        const fig = (match[1] == "buying") ? parseFig(match[2]) : (hook.centsOrFig as Figurine);
        const { sells, buys } = getMarket(fig);

        switch (match[1]) {
          case "buying":       buys.splice( buys.findIndex(x => x.hookId == hookId), 1); break;
          case "selling for": sells.splice(sells.findIndex(x => x.hookId == hookId), 1); break;
        };
      } break;
      case "receivedCents": {
        const { cents, "from": senderId, "for": figTxt } = req.body;

        let fig; try { fig = parseFig(figTxt); } catch (e) {
          return void await sendScales("pay", {
            "receiverId": senderId,
            "for": "what kinda fig is that!?",
            cents,
          });
        }
        const { hist, sells, buys } = getMarket(fig);
        sells.sort((a, b) => a.demandsCents - b.demandsCents);

        /* they can buy their fig immediately if they've offered
         * more than the cheapest sell costs */
        if (sells.length && cents >= sells[0].demandsCents) {
          await sendScales("pullhook", { hookId: sells[0].hookId });
          await sendScales("givefig", {
            "receiverId": senderId,
            "for": cents,
            fig,
          });
          const [{madeOn, seller, demandsCents}] = sells.splice(0, 1);
          await sendScales("pay", {
            "receiverId": seller,
            "cents": demandsCents,
            "for": ppfig(fig),
          });
          hist.push({
            buyer: senderId,
            seller,
            finishedOn: Date.now(),
            startedOn: madeOn,
            buyerInitiated: true,
            cents,
          });
          setTimeout(writeMarket, 0);
          return;
        }

        /* send them back their money, but hooked so we can yank it again later */
        const { hookId } = await sendScales("pay", {
          "receiverId": senderId,
          "hook": { "desc": `buying ${figTxt}` },
          cents,
        });
        buys.push({
          buyer: senderId,
          offersCents: cents,
          madeOn: Date.now(),
          hookId,
        });
        app.client.chat.postMessage({
          channel: stripId(senderId)!,
          text: `Your buy order to purchase a ${ppfig(fig)} at ${ppcents(cents)} is now up!` +
            "\nYou can manage it through `/sc bal`."
        });
      } break;
      case "receivedFig": {
        const { fig, "from": senderId, "for": sellFor } = req.body;

        /* scales forwards us the for field from the user so we need to verify
         * it's actually a price they want to sell this for, and send them their fig
         * back otherwise. */
        let cents = parseInt(parseFloat(sellFor) * 100 + "");
        if (isNaN(cents))
          return await void sendScales("givefig", {
            "receiverId": senderId,
            fig,
            "for": `expected price, found ${sellFor}`,
          });

        const { sells, buys, hist } = getMarket(fig);
        buys.sort((a, b) => b.offersCents - a.offersCents);

        /* they can buy their fig immediately if they've demanded
         * less than or equal to what the most generous buy order offers */
        if (buys.length && cents <= buys[0].offersCents) {
          await sendScales("pullhook", { hookId: buys[0].hookId });
          await sendScales("pay", {
            "receiverId": senderId,
            "cents": buys[0].offersCents,
            "for": ppfig(fig),
          });
          const [{madeOn, buyer, offersCents}] = buys.splice(0, 1);
          await sendScales("givefig", {
            "receiverId": buyer,
            "fig": fig,
            "for": offersCents,
          });
          hist.push({
            buyer,
            seller: senderId,
            startedOn: madeOn,
            finishedOn: Date.now(),
            buyerInitiated: false,
            cents,
          });
          setTimeout(writeMarket, 0);
          return;
        }
        const { hookId } = await sendScales("givefig", {
          "receiverId": senderId,
          "hook": { "desc": `selling for ${ppcents(cents)}` },
          fig,
        });
        sells.push({
          seller: senderId,
          demandsCents: cents,
          madeOn: Date.now(),
          hookId,
        });
        app.client.chat.postMessage({
          channel: stripId(senderId)!,
          text: `Your ${ppfig(fig)} is now up for sale at ${ppcents(cents)}!` +
            "\nAll of your sales can be managed through `/sc bal`."
        });
      } break;
    }

    setTimeout(writeMarket, 0);
  }));

})();

app.action("fig_buy", forwardErrToUser(async ({ ack, respond, action }) => {
  await ack();
  const { value: figTxt } = action as any;
  const { blocks } = figShopPage(figTxt);

  const { sells } = getMarket(parseFig(figTxt));
  sells.sort((a, b) => a.demandsCents - b.demandsCents);

  let text;
  if (sells.length)
    text = `Enter */sc pay <@${ids.me}> ${sells[0].demandsCents/100} for ${figTxt}*` +
      `, to purchase this figurine immediately. You can also provide a lower amount` +
      `, for those selling this figurine to consider.`;
  else
    text = `Enter */sc pay <@${ids.me}> 50 for ${figTxt}*, for example` +
      `, if you want to offer ${ppcents(5000)} for this figurine.`;

  blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
  return await respond({ text, blocks });
}));

app.action("fig_sell", forwardErrToUser(async ({ ack, respond, action }) => {
  await ack();
  const { value: figTxt } = action as any;
  const { blocks } = figShopPage(figTxt);

  const { buys } = getMarket(figTxt);
  buys.sort((a, b) => b.offersCents - a.offersCents);

  let text;
  if (buys.length)
    text = `Enter */sc givefig <@${ids.me}> ${figTxt} for ${buys[0].offersCents/100}*` +
      `, to sell this figurine immediately. You can also provide a higher amount` +
      `, for those buying this figurine to consider.`;
  else
    text = `Enter */sc givefig <@${ids.me}> ${figTxt} for 50*, for example` +
      `, if you want to put this fig up for sale at ${ppcents(5000)}.`;

  blocks.push({ "type": "section", "text": { "type": "mrkdwn", text } });
  return await respond({ text, blocks });
}));

app.command('/figmp', forwardErrToUser(async ({ command, ack, respond, say }) => {
  await ack();
  console.log(`${command.user_id} ran /figmp ${command.text}`);

  const [cmd, figTxt] = command.text.trim().split(/\s+/);

  switch (cmd) {
    case "say":
      if (command.user_id != ids.ced)
        return await respond("hey only ced can use this command :angerydog:");
      return await say(command.text.trim().split(/\s+/).slice(1).join(' '));
    case "shop":
      if (figTxt) return await respond(figShopPage(figTxt));
      return await respond(figShopFrontPage());
    case "faq":
      return await respond(faqText);
    default: 
      return await respond(helpText);
  }
}));

function forwardErrToUser(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    fn(args).catch(e => args.respond(
      (e instanceof BadInput)
        ? ("Bad Input: " + e.message)
        : (console.error(e), "Bot Internals: " + e)
    ));
  }
}

app.start(3001).then(() => console.log('⚡️ Bolt app is running!'));
