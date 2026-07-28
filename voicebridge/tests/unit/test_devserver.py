"""Dev-runner tests: the tunnel URL must be found in cloudflared's real log
shape, and the banner must carry the three URLs that need pasting."""

from app.devserver import banner, extract_tunnel_url


class TestExtractTunnelUrl:
    def test_finds_the_url_in_a_real_log_line(self) -> None:
        line = (
            "2026-07-28T19:11:20Z INF |  https://cad-region-ship-tune.trycloudflare.com  "
            "                        |"
        )
        assert extract_tunnel_url(line) == "https://cad-region-ship-tune.trycloudflare.com"

    def test_ignores_unrelated_lines(self) -> None:
        assert extract_tunnel_url("2026-07-28T19:11:20Z INF Initial protocol quic") is None

    def test_ignores_other_cloudflare_urls(self) -> None:
        line = "see https://developers.cloudflare.com/cloudflare-one/ for named tunnels"
        assert extract_tunnel_url(line) is None


class TestBanner:
    def test_carries_every_url_that_must_be_pasted(self) -> None:
        text = banner("https://x.trycloudflare.com")
        assert "https://x.trycloudflare.com/twilio/voice" in text
        assert "https://x.trycloudflare.com/operator" in text
        assert "https://x.trycloudflare.com/debug/last-call" in text

    def test_warns_that_the_address_changes(self) -> None:
        assert "changes every restart" in banner("https://x.trycloudflare.com")
