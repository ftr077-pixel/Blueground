"""Runs the §6.1 conformance suite against the fake adapter, which keeps the
suite itself honest until TwilioAdapter (M0) subclasses it."""

from app.telephony.base import TelephonyAdapter
from tests.support.conformance import AdapterControls, TelephonyAdapterConformance
from tests.support.fakes import FakeTelephonyAdapter


class TestFakeAdapterConformance(TelephonyAdapterConformance):
    async def make(self) -> tuple[TelephonyAdapter, AdapterControls]:
        adapter = FakeTelephonyAdapter()
        return adapter, AdapterControls(
            feed=adapter.feed,
            end_inbound=adapter.end_inbound,
            sent_frames=adapter.sent_frames,
            flush_count=adapter.flush_count,
        )
