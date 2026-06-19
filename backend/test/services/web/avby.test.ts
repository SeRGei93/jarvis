import { describe, it, expect } from "vitest";
import { extractAvByListingContent } from "../../../src/services/web/avby/av-by.js";

describe("extractAvByListingContent — photos", () => {
  it("appends og:image + same-host gallery photos as 'Фото:' lines, dropping cross-host logos", () => {
    const html = `<html><head>
        <title>Audi A4 — av.by</title>
        <meta property="og:image" content="https://content.av.by/cars/abc/1.jpg">
      </head><body>
        <div class="card">
          <h1>Audi A4 B9 2019</h1>
          <div class="card__gallery">
            <img src="https://content.av.by/cars/abc/1.jpg">
            <img src="https://content.av.by/cars/abc/2.jpg">
            <img src="https://static.av.by/img/dealer-logo.png">
          </div>
          <div class="card__price">73 420 BYN</div>
        </div>
      </body></html>`;

    const res = extractAvByListingContent(html);
    expect(res).not.toBeNull();
    // og:image is the lead photo; the same-host gallery photo is added; no duplicates.
    expect(res!.html).toContain("Фото: https://content.av.by/cars/abc/1.jpg");
    expect(res!.html).toContain("Фото: https://content.av.by/cars/abc/2.jpg");
    // Cross-host dealer logo is filtered out.
    expect(res!.html).not.toContain("dealer-logo.png");
    // Listing text is preserved (images stripped from the body, URLs appended).
    expect(res!.html).toContain("73 420 BYN");
    // og:image appears once even though it is also an <img> in the gallery.
    expect(res!.html.match(/abc\/1\.jpg/g)).toHaveLength(1);
  });

  it("emits no 'Фото:' lines when the listing has no images", () => {
    const html = `<html><head><title>t</title></head><body>
        <div class="card"><h1>Car</h1><div class="card__price">100 BYN</div></div>
      </body></html>`;
    const res = extractAvByListingContent(html);
    expect(res).not.toBeNull();
    expect(res!.html).not.toContain("Фото:");
    expect(res!.html).toContain("100 BYN");
  });
});
