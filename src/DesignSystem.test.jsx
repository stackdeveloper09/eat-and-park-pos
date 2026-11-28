import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chip, StatusBadge, TypeBadge } from "./DesignSystem";

describe("shared design system components", () => {
  it("renders active filter chips with pressed state", () => {
    const markup = renderToStaticMarkup(<Chip active>All Orders</Chip>);

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("ep-ds-chip");
  });

  it("maps table/order statuses and order types to their visual variants", () => {
    const markup = renderToStaticMarkup(
      <>
        <StatusBadge status="Reserved" kind="table" />
        <StatusBadge status="new" />
        <StatusBadge status="Preparing" />
        <TypeBadge type="Take Away" />
      </>,
    );

    expect(markup).toContain("ep-ds-status--reserved");
    expect(markup).toContain(">New</span>");
    expect(markup).toContain("ep-ds-status--preparing");
    expect(markup).toContain("ep-ds-type--take-away");
  });
});
