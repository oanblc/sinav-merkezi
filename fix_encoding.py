# -*- coding: utf-8 -*-
import os
import re

def fix_file(filepath):
    try:
        with open(filepath, 'rb') as f:
            raw = f.read()

        # Remove BOM
        if raw.startswith(b'\xef\xbb\xbf'):
            raw = raw[3:]

        content = raw.decode('utf-8', errors='replace')
        original = content

        # These are the actual corrupted patterns found in the file
        # Mapping corrupted sequences to correct Turkish characters
        byte_replacements = {
            # I (dotted) - found pattern
            b'\xc3\x83\xc6\x92\xc3\x82\xe2\x80\x9e\xc3\x83\xe2\x80\x9a\xc3\x82\xc2\xb0': 'I'.encode('utf-8'),
            # i (dotless) - similar pattern with b1 instead of b0
            b'\xc3\x83\xc6\x92\xc3\x82\xe2\x80\x9e\xc3\x83\xe2\x80\x9a\xc3\x82\xc2\xb1': 'i'.encode('utf-8'),
        }

        # Apply byte-level replacements first
        modified_raw = raw
        for old_bytes, new_bytes in byte_replacements.items():
            modified_raw = modified_raw.replace(old_bytes, new_bytes)

        if modified_raw != raw:
            content = modified_raw.decode('utf-8', errors='replace')

        # Now apply string-level replacements for simpler patterns
        string_replacements = [
            # Common mojibake patterns
            ('Ã¼', 'u'),
            ('Ã¶', 'o'),
            ('Ã§', 'c'),
            ('Ãœ', 'U'),
            ('Ã–', 'O'),
            ('Ã‡', 'C'),
            ('Ä±', 'i'),
            ('Ä°', 'I'),
            ('ÅŸ', 's'),
            ('Åž', 'S'),
            ('ÄŸ', 'g'),
            ('Äž', 'G'),
        ]

        for old, new in string_replacements:
            content = content.replace(old, new)

        if content != original:
            with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
                f.write(content)
            return True
        return False
    except Exception as e:
        print(f"Error: {filepath} - {e}")
        return False

def main():
    base_dir = r"C:\Users\yusuf\Desktop\sinav-merkezi"
    extensions = ['.js', '.ejs', '.html', '.css', '.md']
    exclude = ['node_modules', '.git', 'uploads']

    fixed = 0
    for root, dirs, files in os.walk(base_dir):
        dirs[:] = [d for d in dirs if d not in exclude]
        for f in files:
            if any(f.endswith(e) for e in extensions):
                path = os.path.join(root, f)
                if fix_file(path):
                    print(f"Fixed: {f}")
                    fixed += 1

    print(f"\nTotal: {fixed} files fixed")

if __name__ == '__main__':
    main()
