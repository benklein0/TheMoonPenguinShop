// src/caption.js
// Uses Claude API to generate Instagram captions + hashtags for listings

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateCaption(listing) {
  console.log(`✍️  Generating caption for: ${listing.title}`);

  const prompt = `You are a social media manager for TheMoonPenguinShop, a handmade Etsy shop that sells beautiful brass figural resin accessories like keychains, compact mirrors, and bag hooks. The shop has a whimsical, feminine, artsy aesthetic.

Write an engaging Instagram Reels caption for this product listing:

Title: ${listing.title}
${listing.price ? `Price: ${listing.price}` : ''}
${listing.description ? `Description: ${listing.description}` : ''}

Requirements:
- 2-4 sentences max, warm and enthusiastic tone
- ALWAYS emphasize that the item is handmade — use phrases like "handcrafted by hand", "made by hand", "one-of-a-kind handmade piece", "lovingly handcrafted" etc. This must be prominent, not an afterthought
- Do NOT include any URLs or links in the caption
- End the caption with a natural call to action referencing the link in bio, like "Shop via the link in bio", "Find it at the link in bio", "Grab yours via the link in bio" etc.
- End with 15-20 relevant hashtags on a new line
- Hashtags should include a mix of: #themoonpenguinshop, niche product tags, aesthetic tags (#cottagecore, #darkacademia, #witchyvibes, #resinart, #handmadejewelry etc.), and shopping tags (#etsyshop, #handmade, #smallbusiness)
- Do NOT use emojis in the caption text, only in hashtags if appropriate
- Keep the caption text itself under 300 characters (not counting hashtags)

Return ONLY the caption text + hashtags, nothing else.`;

  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const caption = message.content[0].text.trim();
  console.log(`✅ Caption generated.`);
  return caption;
}

module.exports = { generateCaption };
