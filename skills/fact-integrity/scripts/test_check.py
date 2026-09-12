"""임상 명사와 실제 역치 한정어의 충돌을 확인한다."""
import unittest

from check import qualifier_count


class QualifierTests(unittest.TestCase):
    def test_adverse_event_is_not_a_threshold(self):
        self.assertEqual(qualifier_count("중대한 이상사건이 없었다", "이상"), 0)

    def test_real_threshold_is_preserved_beside_adverse_event(self):
        self.assertEqual(qualifier_count("7일 이상 지속. 이상사건 보고.", "이상"), 1)

    def test_adverse_event_cannot_mask_a_lost_threshold(self):
        base = qualifier_count("7일 이상 지속되면 연락한다", "이상")
        derived = qualifier_count("지속되면 연락한다. 이상사건 보고.", "이상")
        self.assertGreater(base, 0)
        self.assertEqual(derived, 0)

    def test_attached_particle_and_other_qualifiers_are_preserved(self):
        self.assertEqual(qualifier_count("7일 이상이면 연락한다", "이상"), 1)
        self.assertEqual(qualifier_count("36도 미만이면 연락한다", "미만"), 1)


if __name__ == "__main__":
    unittest.main()
