import time


class ReadError(Exception):
    pass


def flv_stream(open_source, sleep):
    timeline = {"started": False, "last": -1}
    delays = (500, 1000, 2000)
    failures = 0
    while True:
        reader = open_source()
        previous = timeline["last"]
        try:
            yield from _read_flv(reader, timeline)
            failures = 0
        except ReadError as error:
            if timeline["last"] - previous >= 10000:
                failures = 0
            if failures == len(delays):
                raise error.__cause__
            failures += 1
        finally:
            reader.close()
        if failures:
            sleep(delays[failures - 1])


def _read_flv(reader, timeline):
    read = _read_bytes(reader)
    header = _read_header(read)
    continuing = timeline["started"]
    if not continuing:
        timeline["started"] = True
        yield header
    clock = {"base": None, "start": timeline["last"] + 1, "previous": 0, "wrap": 0}
    count, size, batch = 0, 0, []
    flush_at = time.monotonic() + 0.25
    failure = None
    try:
        while True:
            tag = read(11)
            if tag is None:
                break
            type = tag[0]
            length = _uint24(tag, 1)
            if type not in (8, 9, 18) or _uint24(tag, 8) != 0:
                raise ValueError("直播 FLV 封包無效")
            data = read(length + 4)
            if data is None:
                break
            if int.from_bytes(data[length:], "big") != length + 11:
                raise ValueError("直播 FLV 封包長度錯誤")
            if type == 18 and continuing:
                continue
            media = _is_media(type, data, length)
            count += int(media)
            value = _timestamp(tag, clock, timeline, media) & 0xffffffff
            tag = bytearray(tag)
            tag[4:8] = bytes((value >> 16 & 255, value >> 8 & 255, value & 255, value >> 24))
            batch.extend((tag, data))
            size += len(tag) + len(data)
            if size >= 65536 or time.monotonic() >= flush_at:
                yield b"".join(batch)
                batch, size = [], 0
                flush_at = time.monotonic() + 0.25
    except ReadError as error:
        failure = error
    if size:
        yield b"".join(batch)
    if failure:
        raise failure
    if not count:
        raise ValueError("直播串流已結束，沒有可續接的媒體資料")


def _read_header(read):
    header = read(9)
    if header is None or bytes(header[:4]) != b"FLV\x01":
        raise ValueError("直播串流不是 FLV")
    offset = int.from_bytes(header[5:9], "big")
    if not 9 <= offset <= 65536:
        raise ValueError("直播 FLV 標頭無效")
    extra = read(offset - 9 + 4)
    if extra is None:
        raise ValueError("直播 FLV 標頭不完整")
    return bytes(header) + bytes(extra)


def _read_bytes(reader):
    chunk, offset = memoryview(b""), 0

    def read(size):
        nonlocal chunk, offset
        result = None
        position = 0
        while position < size:
            if offset == len(chunk):
                try:
                    value = reader.read()
                except Exception as error:
                    raise ReadError(str(error)) from error
                if value is None:
                    return None
                chunk, offset = memoryview(value), 0
            count = min(size - position, len(chunk) - offset)
            if position == 0 and count == size:
                view = chunk[offset:offset + count]
                offset += count
                return view
            if result is None:
                result = bytearray(size)
            result[position:position + count] = chunk[offset:offset + count]
            position += count
            offset += count
        return result

    return read


def _uint24(data, offset):
    return int.from_bytes(data[offset:offset + 3], "big")


def _is_media(type, data, length):
    if length < 2 or type == 18:
        return False
    if type == 8:
        return data[0] >> 4 != 10 or data[1] == 1
    return data[0] & 15 not in (7, 12) or data[1] == 1


def _timestamp(tag, clock, timeline, media):
    if not media:
        return max(0, timeline["last"])
    value = _uint24(tag, 4) + tag[7] * 16777216
    if clock["previous"] - value > 2147483648:
        clock["wrap"] += 4294967296
    clock["previous"] = value
    current = value + clock["wrap"]
    if clock["base"] is None:
        clock["base"] = current
    result = max(0, clock["start"] + current - clock["base"])
    timeline["last"] = max(timeline["last"], result)
    return result
