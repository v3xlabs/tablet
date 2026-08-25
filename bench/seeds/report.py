from store import SalesStore


def region_lines(store: SalesStore) -> list[str]:
    lines = []
    for region in store.regions():
        lines.append(f"{region}: {store.revenue(region):.2f}")
    return lines


def headline(store: SalesStore) -> str:
    return f"total revenue: {store.revenue():.2f}"


def build_report(store: SalesStore) -> str:
    parts = [headline(store)]
    parts.extend(region_lines(store))
    top = store.top_product()
    if top is None:
        parts.append("no sales recorded")
    else:
        parts.append(f"top product: {top}")
    return "\n".join(parts)


def save_report(store: SalesStore, path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(build_report(store))
        handle.write("\n")
