from dataclasses import dataclass, field


@dataclass
class Sale:
    product: str
    amount: float
    region: str


@dataclass
class SalesStore:
    sales: list[Sale] = field(default_factory=list)

    def record(self, sale: Sale) -> None:
        self.sales.append(sale)

    def revenue(self, region: str | None = None) -> float:
        held = self.sales if region is None else [sale for sale in self.sales if sale.region == region]
        return sum(sale.amount for sale in held)

    def regions(self) -> list[str]:
        seen: list[str] = []
        for sale in self.sales:
            if sale.region not in seen:
                seen.append(sale.region)
        return seen

    def top_product(self) -> str | None:
        totals: dict[str, float] = {}
        for sale in self.sales:
            totals[sale.product] = totals.get(sale.product, 0.0) + sale.amount
        if not totals:
            return None
        return max(totals, key=lambda name: totals[name])
