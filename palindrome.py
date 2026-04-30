def is_palindrome(s: str) -> bool:
    """Return True if the string is a palindrome, False otherwise."""
    return s == s[::-1]
