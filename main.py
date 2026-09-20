from pypdf import PdfReader
from langchain_text_splitters import RecursiveCharacterTextSplitter

reader= PdfReader("data/sample.pdf")

pages=[]

for page in reader.pages:
    text= page.extract_text()
    if text:
        pages.append(text)

document="\n".join(pages)

splitter= RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=100,
)

chunks= splitter.split_text(document)

print(f"Total chunks created: {len(chunks)}")

print("\n" + "=" * 80)
print("CHUNK 1")
print("=" * 80)
print(chunks[0])

print("\n" + "=" * 80)
print("CHUNK 2")
print("=" * 80)
print(chunks[1])